const express = require('express');
const path = require('path');
const { execFileSync } = require('child_process');
const { mapInsightToIssue } = require('./issue-mapper');

// Enrich issueMetrics with cycle time data from gh CLI.
// cache: object used to memoize results across calls (pass {} to create a fresh cache).
// execFn: injectable for testing (defaults to execFileSync).
// Resolve a GitHub owner/repo slug from an issueMeta entry.
// If issue.repo already looks like "owner/repo", use it directly.
// Otherwise fall back to reading the git remote origin from issue.projectPath.
function resolveGitHubRepo(issue, execFn) {
  if (/^[^/\s]+\/[^/\s]+$/.test(issue.repo || '')) return issue.repo;
  if (!issue.projectPath) return null;
  try {
    const remote = execFn(
      'git',
      ['-C', issue.projectPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function enrichIssueCycleTime(issueMetrics, cache = {}, execFn = execFileSync) {
  if (!issueMetrics || !issueMetrics.issueMeta || issueMetrics.issueMeta.length === 0) {
    return issueMetrics;
  }

  const cycleTimes = [];
  const issuesToProcess = issueMetrics.issueMeta.slice(0, 50); // Cap at 50

  for (const issue of issuesToProcess) {
    const resolvedRepo = resolveGitHubRepo(issue, execFn);
    if (!resolvedRepo) continue;

    const cacheKey = `${resolvedRepo}/${issue.number}`;

    // Check cache first
    if (cache[cacheKey] !== undefined) {
      const cycleTime = cache[cacheKey];
      if (cycleTime !== null) {
        cycleTimes.push(cycleTime);
        issue.cycleTimeDays = cycleTime;
      }
      continue;
    }

    // Try to fetch from gh CLI (execFileSync avoids shell interpolation — no injection risk; see #66)
    try {
      const result = execFn(
        'gh',
        ['issue', 'view', String(issue.number), '--repo', resolvedRepo, '--json', 'createdAt,closedAt'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const data = JSON.parse(result);

      if (data.createdAt && data.closedAt) {
        const created = new Date(data.createdAt);
        const closed = new Date(data.closedAt);
        const cycleTime = Math.round((closed - created) / (1000 * 60 * 60 * 24) * 100) / 100;
        cache[cacheKey] = cycleTime;
        cycleTimes.push(cycleTime);
        issue.cycleTimeDays = cycleTime;
        issue.closedAt = data.closedAt;
      } else {
        // Issue not closed, cache null to skip retrying
        cache[cacheKey] = null;
      }
    } catch {
      // gh CLI unavailable or issue not found, cache null to skip retrying
      cache[cacheKey] = null;
    }
  }

  // gh-derived cycle times: only supplement issues not already covered by log-based cycle time
  const ghAvg = cycleTimes.length > 0
    ? Math.round((cycleTimes.reduce((s, t) => s + t, 0) / cycleTimes.length) * 100) / 100
    : 0;

  // Prefer log-based avgCycleTimeDays from parser (covers all history); fall back to gh-only avg
  const avgCycleTimeDays = issueMetrics.avgCycleTimeDays > 0
    ? issueMetrics.avgCycleTimeDays
    : ghAvg;

  return {
    ...issueMetrics,
    avgCycleTimeDays,
  };
}

function createServer() {
  const app = express();
  app.use(express.json());

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData = null;

  // In-memory cache for issue cycle times to avoid repeated gh CLI calls
  const issueCycleTimeCache = {};

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
        // Enrich issueMetrics with cycle time data
        if (cachedData.orchestrator && cachedData.orchestrator.issueMetrics) {
          cachedData.orchestrator.issueMetrics = enrichIssueCycleTime(cachedData.orchestrator.issueMetrics, issueCycleTimeCache);
        }
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      // Clear cycle time cache so closed issues are re-fetched
      Object.keys(issueCycleTimeCache).forEach(k => delete issueCycleTimeCache[k]);
      cachedData = await require('./parser').parseAllSessions();
      // Enrich issueMetrics with cycle time data
      if (cachedData.orchestrator && cachedData.orchestrator.issueMetrics) {
        cachedData.orchestrator.issueMetrics = enrichIssueCycleTime(cachedData.orchestrator.issueMetrics, issueCycleTimeCache);
      }
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/create-issue', async (req, res) => {
    const { insightId, repo, dryRun } = req.body;

    if (!insightId || !repo) {
      return res.status(400).json({ error: 'insightId and repo are required' });
    }

    // Ensure we have cached data with insights
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to parse sessions: ' + err.message });
    }

    // Find the insight by ID
    const insight = (cachedData.insights || []).find(i => i.id === insightId);
    if (!insight) {
      return res.status(404).json({ error: `Insight "${insightId}" not found in current data` });
    }

    // Map insight to issue structure
    const issue = mapInsightToIssue(insight);
    if (!issue) {
      return res.status(400).json({ error: `Insight "${insightId}" is not actionable` });
    }

    // Dry run — return what would be created
    if (dryRun) {
      return res.json({ dryRun: true, title: issue.title, body: issue.body, labels: issue.labels });
    }

    // Check gh CLI availability
    try {
      execFileSync('gh', ['--version'], { stdio: 'pipe' });
    } catch {
      return res.status(500).json({ error: 'gh CLI not found. Install: https://cli.github.com/' });
    }

    // Dedup check — look for open issues with same title
    try {
      const existing = execFileSync(
        'gh',
        ['issue', 'list', '--repo', repo, '--label', 'spend-analysis', '--state', 'open', '--json', 'title,number,url'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const openIssues = JSON.parse(existing || '[]');
      const duplicate = openIssues.find(i => i.title === issue.title);
      if (duplicate) {
        return res.json({ duplicate: true, existingUrl: duplicate.url, number: duplicate.number });
      }
    } catch (err) {
      // Label might not exist yet — that's fine, no duplicates
      if (!err.message.includes('label')) {
        return res.status(500).json({ error: 'Dedup check failed: ' + err.message });
      }
    }

    // Create the issue
    try {
      const labelArgs = issue.labels.flatMap(l => ['--label', l]);
      const result = execFileSync(
        'gh',
        ['issue', 'create', '--repo', repo, '--title', issue.title, ...labelArgs, '--body', '-'],
        { input: issue.body, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const url = result.trim();
      const number = parseInt(url.split('/').pop(), 10);
      return res.json({ created: true, url, number });
    } catch (err) {
      return res.status(500).json({ error: 'Issue creation failed: ' + err.message });
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer, enrichIssueCycleTime };

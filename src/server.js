const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const { mapInsightToIssue } = require('./issue-mapper');

function createServer() {
  const app = express();
  app.use(express.json());

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData = null;

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      cachedData = await require('./parser').parseAllSessions();
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
      execSync('gh --version', { stdio: 'pipe' });
    } catch {
      return res.status(500).json({ error: 'gh CLI not found. Install: https://cli.github.com/' });
    }

    // Dedup check — look for open issues with same title
    try {
      const existing = execSync(
        `gh issue list --repo ${repo} --label spend-analysis --state open --json title,number,url`,
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
      const labelArgs = issue.labels.map(l => `--label "${l}"`).join(' ');
      const result = execSync(
        `gh issue create --repo ${repo} --title "${issue.title.replace(/"/g, '\\"')}" ${labelArgs} --body -`,
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

module.exports = { createServer };

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { mapInsightToIssue, getInsightMapping } = require('./issue-mapper');

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

  // --- AI-powered issue generation via /explore skill ---

  const generateJobs = new Map();
  let jobCounter = 0;

  function resolveClaudeCli() {
    const localPath = path.join(process.env.HOME || '', '.claude', 'local', 'claude');
    if (fs.existsSync(localPath)) return localPath;
    return 'claude';
  }

  function sanitizeRepoPath(p) {
    if (!p || typeof p !== 'string') return null;
    if (/\.\./.test(p)) return null;
    if (/[;&|`$(){}!\n\r]/.test(p)) return null;
    return p;
  }

  app.post('/api/generate-issue', async (req, res) => {
    const { insightId, repo, repoPath } = req.body;

    if (!insightId || !repo || !repoPath) {
      return res.status(400).json({ error: 'insightId, repo, and repoPath are required' });
    }

    const safePath = sanitizeRepoPath(repoPath);
    if (!safePath) {
      return res.status(400).json({ error: 'Invalid repoPath: must be an absolute path without ".." or shell metacharacters' });
    }

    // Verify the explore skill exists in the target repo
    const skillPath = path.join(safePath, '.claude', 'skills', 'explore', 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      return res.status(400).json({ error: `Explore skill not found at ${skillPath}. Install the /explore skill first.` });
    }

    // Only one job at a time
    for (const job of generateJobs.values()) {
      if (job.status === 'running') {
        return res.status(409).json({ error: 'A generation job is already running', jobId: job.id });
      }
    }

    // Ensure we have cached data with insights
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to parse sessions: ' + err.message });
    }

    const insight = (cachedData.insights || []).find(i => i.id === insightId);
    if (!insight) {
      return res.status(404).json({ error: `Insight "${insightId}" not found in current data` });
    }

    const rawMapping = getInsightMapping(insightId);
    const targetFiles = rawMapping && rawMapping.targetFiles ? rawMapping.targetFiles.join(', ') : 'N/A';
    const labels = rawMapping && rawMapping.labels ? rawMapping.labels.join(', ') : '';

    const prompt = `Use /explore to create a GitHub issue about: ${insight.title}. ${insight.description || ''}. ${insight.action || ''}. Target repo: ${repo}. The issue should target these files: ${targetFiles}. Labels: ${labels}.`;

    const jobId = ++jobCounter;
    const claudePath = resolveClaudeCli();

    const child = spawn(claudePath, ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json'], {
      cwd: safePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    const job = {
      id: jobId,
      status: 'running',
      process: child,
      insightId,
      startedAt: new Date().toISOString(),
      result: null,
      error: null
    };
    generateJobs.set(jobId, job);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        job.status = 'completed';
        try {
          job.result = JSON.parse(stdout);
        } catch {
          job.result = { raw: stdout };
        }
        // Try to extract a GitHub issue URL from the output
        const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s"]+\/issues\/\d+/);
        if (urlMatch) {
          job.result.issueUrl = urlMatch[0];
        }
      } else {
        job.status = 'failed';
        job.error = stderr || `Process exited with code ${code}`;
      }
      job.process = null; // release reference
    });

    child.on('error', (err) => {
      job.status = 'failed';
      job.error = err.message;
      job.process = null;
    });

    return res.json({ jobId });
  });

  app.get('/api/generate-issue/status/:jobId', (req, res) => {
    const jobId = parseInt(req.params.jobId, 10);
    const job = generateJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    const response = { status: job.status };
    if (job.status === 'completed') {
      response.result = job.result;
    } else if (job.status === 'failed') {
      response.error = job.error;
    }
    return res.json(response);
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };

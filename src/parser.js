const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

// Pricing model: USD per million tokens (MTok)
const PRICING = {
  haiku:  { input: 0.25,  output: 1.25 },
  sonnet: { input: 3.0,   output: 15.0 },
  opus:   { input: 15.0,  output: 75.0 },
};

function getModelPricing(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku'))  return PRICING.haiku;
  if (m.includes('opus'))   return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  return null;
}

function calculateCost(inputTokens, outputTokens, model) {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function extractSessionData(entries) {
  const queries = [];
  let pendingUserMessage = null;

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) continue;

      const textContent = typeof content === 'string'
        ? content
        : content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      pendingUserMessage = {
        text: textContent || null,
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant' && entry.message?.usage) {
      const usage = entry.message.usage;
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;

      const inputTokens = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      const outputTokens = usage.output_tokens || 0;

      const tools = [];
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name) tools.push(block.name);
        }
      }

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp || null,
        assistantTimestamp: entry.timestamp,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cost: calculateCost(inputTokens, outputTokens, model),
        tools,
      });
    }
  }

  return queries;
}

async function parseAllSessions() {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return { sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [], totals: {} };
  }

  // Read history.jsonl for prompt display text
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];

  // Build a map: sessionId -> first meaningful prompt
  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
      const display = entry.display.trim();
      if (display.startsWith('/') && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = fs.readdirSync(projectsDir).filter(d => {
    return fs.statSync(path.join(projectsDir, d)).isDirectory();
  });

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = []; // for "most expensive prompts" across all sessions

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');

      let entries;
      try {
        entries = await parseJSONLFile(filePath);
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const queries = extractSessionData(entries);
      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0, estimatedCost = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
        estimatedCost += q.cost || 0;
      }
      const totalTokens = inputTokens + outputTokens;

      const firstTimestamp = entries.find(e => e.timestamp)?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      // Primary model
      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

      const firstPrompt = sessionFirstPrompt[sessionId]
        || queries.find(q => q.userPrompt)?.userPrompt
        || '(no prompt)';

      // Collect per-prompt data for "most expensive prompts"
      // Group consecutive queries under the same user prompt
      let currentPrompt = null;
      let promptInput = 0, promptOutput = 0, promptCost = 0;
      const flushPrompt = () => {
        if (currentPrompt && (promptInput + promptOutput) > 0) {
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: promptInput,
            outputTokens: promptOutput,
            totalTokens: promptInput + promptOutput,
            estimatedCost: promptCost,
            date,
            sessionId,
            model: primaryModel,
          });
        }
      };
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          promptInput = 0;
          promptOutput = 0;
          promptCost = 0;
        }
        promptInput += q.inputTokens;
        promptOutput += q.outputTokens;
        promptCost += q.cost || 0;
      }
      flushPrompt();

      sessions.push({
        sessionId,
        project: projectDir,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
      });

      // Daily
      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0, queries: 0, estimatedCost: 0 };
        }
        dailyMap[date].inputTokens += inputTokens;
        dailyMap[date].outputTokens += outputTokens;
        dailyMap[date].totalTokens += totalTokens;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries += queries.length;
        dailyMap[date].estimatedCost += estimatedCost;
      }

      // Model
      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0, estimatedCost: 0 };
        }
        modelMap[q.model].inputTokens += q.inputTokens;
        modelMap[q.model].outputTokens += q.outputTokens;
        modelMap[q.model].totalTokens += q.totalTokens;
        modelMap[q.model].queryCount += 1;
        modelMap[q.model].estimatedCost += q.cost || 0;
      }
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  // Build per-project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        sessionCount: 0, queryCount: 0, estimatedCost: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;
    p.estimatedCost += session.estimatedCost || 0;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0, estimatedCost: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
      m.estimatedCost += q.cost || 0;
    }

    // Per-project prompt grouping with tool tracking
    let curPrompt = null, curInput = 0, curOutput = 0, curConts = 0;
    let curModels = {}, curTools = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          continuations: curConts,
          model: topModel,
          toolCounts: { ...curTools },
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curConts = 0;
        curModels = {}; curTools = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
      if (q.model && q.model !== '<synthetic>') curModels[q.model] = (curModels[q.model] || 0) + 1;
      for (const t of q.tools || []) curTools[t] = (curTools[t] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    estimatedCost: p.estimatedCost,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Top 20 most expensive individual prompts
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    totalEstimatedCost: sessions.reduce((sum, s) => sum + (s.estimatedCost || 0), 0),
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  // Generate insights
  const insights = generateInsights(sessions, allPrompts, grandTotals);

  // Build project->cost map for orchestrator run cost correlation
  const projectCostMap = {};
  for (const s of sessions) {
    projectCostMap[s.project] = (projectCostMap[s.project] || 0) + (s.estimatedCost || 0);
  }

  // Parse orchestrator logs from project directories
  const orchestrator = parseOrchestratorLogs(projectCostMap);
  const orchestratorInsights = generateOrchestratorInsights(orchestrator);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights: [...insights, ...orchestratorInsights],
    orchestrator,
  };
}

function emptySummary() {
  return { totalRuns: 0, completedRuns: 0, errorRuns: 0, maxIterationsRuns: 0, completionRate: 0, avgQualityIterations: 0, avgTestIterations: 0, stageAvgs: [], topChurners: [] };
}

function parseOrchestratorLogs(projectCostMap = {}) {
  const runs = [];

  // Encode a filesystem path to the format used in ~/.claude/projects/
  // e.g. /Users/foo/bar -> -Users-foo-bar  (leading dash preserved — Claude dirs start with -)
  function encodeProjectPath(p) {
    return p.replace(/\//g, '-');
  }

  // Scan ~/projects/*/ for orchestrator log directories
  const projectsRoot = path.join(os.homedir(), 'projects');
  if (!fs.existsSync(projectsRoot)) return { runs: [], summary: emptySummary() };

  let projectDirNames;
  try { projectDirNames = fs.readdirSync(projectsRoot); } catch { return { runs: [], summary: emptySummary() }; }

  const logPatterns = ['logs/implement-issue', 'logs/test-fix-loop'];

  for (const projName of projectDirNames) {
    const projPath = path.join(projectsRoot, projName);
    try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

    for (const pattern of logPatterns) {
      const logsDir = path.join(projPath, pattern);
      if (!fs.existsSync(logsDir)) continue;

      let entries;
      try { entries = fs.readdirSync(logsDir); } catch { continue; }

      for (const entry of entries) {
        const statusPath = path.join(logsDir, entry, 'status.json');
        if (!fs.existsSync(statusPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
          const stages = raw.stages || {};

          // Calculate stage durations
          const stageDurations = {};
          for (const [name, stage] of Object.entries(stages)) {
            if (stage.started_at && stage.completed_at) {
              stageDurations[name] = (new Date(stage.completed_at) - new Date(stage.started_at)) / 1000;
            }
          }

          // Extract date from directory name (e.g., issue-17-20260221-090547)
          const dateMatch = entry.match(/(\d{8})-(\d{6})$/);
          const date = dateMatch
            ? `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}`
            : null;

          // Calculate cost from worktree sessions
          const runBaseDir = path.join(logsDir, entry);
          let estimatedCost = 0;
          const worktreesDir = path.join(runBaseDir, 'worktrees');
          if (fs.existsSync(worktreesDir)) {
            try {
              const worktrees = fs.readdirSync(worktreesDir);
              for (const wt of worktrees) {
                const wtPath = path.join(worktreesDir, wt);
                const encodedPath = encodeProjectPath(wtPath);
                estimatedCost += projectCostMap[encodedPath] || 0;
              }
            } catch { /* skip */ }
          }

          runs.push({
            project: projName,
            projectPath: projPath,
            logType: pattern.split('/').pop(),
            issue: raw.issue || null,
            state: raw.state || 'unknown',
            taskCount: (raw.tasks || []).length,
            qualityIterations: raw.quality_iterations || stages.quality_loop?.iteration || 0,
            testIterations: raw.test_iterations || stages.test_loop?.iteration || 0,
            prReviewIterations: raw.pr_review_iterations || stages.pr_review?.iteration || 0,
            stageDurations,
            date,
            dirName: entry,
            estimatedCost,
          });
        } catch {
          // Skip malformed status.json
        }
      }
    }
  }

  // Sort by date descending
  runs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Generate summary
  const validRuns = runs.filter(r => r.state !== 'initializing');
  const completedRuns = validRuns.filter(r => r.state === 'completed');
  const errorRuns = validRuns.filter(r => r.state === 'error');
  const maxIterRuns = validRuns.filter(r => r.state.startsWith('max_iterations'));
  const runsWithQuality = validRuns.filter(r => r.qualityIterations > 0);
  const runsWithTests = validRuns.filter(r => r.testIterations > 0);

  const avgQuality = runsWithQuality.length > 0
    ? runsWithQuality.reduce((s, r) => s + r.qualityIterations, 0) / runsWithQuality.length
    : 0;
  const avgTests = runsWithTests.length > 0
    ? runsWithTests.reduce((s, r) => s + r.testIterations, 0) / runsWithTests.length
    : 0;

  // Find stage bottlenecks
  const stageTotals = {};
  const stageCounts = {};
  for (const run of validRuns) {
    for (const [name, duration] of Object.entries(run.stageDurations)) {
      stageTotals[name] = (stageTotals[name] || 0) + duration;
      stageCounts[name] = (stageCounts[name] || 0) + 1;
    }
  }
  const stageAvgs = Object.entries(stageTotals).map(([name, total]) => ({
    name,
    avgSeconds: Math.round(total / stageCounts[name]),
    count: stageCounts[name],
  })).sort((a, b) => b.avgSeconds - a.avgSeconds);

  // Top churners (highest iteration counts)
  const topChurners = [...validRuns]
    .sort((a, b) => (b.qualityIterations + b.testIterations) - (a.qualityIterations + a.testIterations))
    .slice(0, 5)
    .filter(r => r.qualityIterations + r.testIterations > 0);

  return {
    runs,
    summary: {
      totalRuns: validRuns.length,
      completedRuns: completedRuns.length,
      errorRuns: errorRuns.length,
      maxIterationsRuns: maxIterRuns.length,
      completionRate: validRuns.length > 0 ? Math.round((completedRuns.length / validRuns.length) * 100) : 0,
      avgQualityIterations: Math.round(avgQuality * 10) / 10,
      avgTestIterations: Math.round(avgTests * 10) / 10,
      stageAvgs,
      topChurners,
    },
  };
}

function generateOrchestratorInsights(orchestrator) {
  const insights = [];
  const { summary, runs } = orchestrator;
  if (!summary || summary.totalRuns < 3) return insights;

  // 1. Quality loop churn
  if (summary.avgQualityIterations > 2) {
    const worst = summary.topChurners.filter(r => r.qualityIterations > 2);
    const worstList = worst.map(r => `#${r.issue} (${r.qualityIterations} iterations)`).join(', ');
    insights.push({
      id: 'quality-churn',
      type: 'warning',
      lens: 'Quality',
      title: `Quality loop averaging ${summary.avgQualityIterations} iterations per run`,
      description: `Across ${summary.totalRuns} pipeline runs, the quality review loop averages ${summary.avgQualityIterations} iterations. Ideal is 1-2. Worst offenders: ${worstList || 'none over 2'}. Each extra iteration means the implementer's output didn't meet the reviewer's standards, costing a full re-review cycle.`,
      action: 'Review the implementer prompt and code-quality-reviewer prompt. Common fixes: add specific coding standards to implementer prompt, reduce reviewer strictness on style-only issues, or improve the task descriptions to be more precise.',
    });
  }

  // 2. Test loop churn
  if (summary.avgTestIterations > 2) {
    const worst = runs.filter(r => r.testIterations > 2).slice(0, 3);
    const worstList = worst.map(r => `#${r.issue} (${r.testIterations} iterations)`).join(', ');
    insights.push({
      id: 'test-churn',
      type: 'warning',
      lens: 'Quality',
      title: `Test loop averaging ${summary.avgTestIterations} iterations per run`,
      description: `The test-fix loop averages ${summary.avgTestIterations} iterations across runs with test activity. Worst: ${worstList || 'n/a'}. Each iteration means tests failed after implementation, requiring a fix cycle.`,
      action: 'Strengthen the implementer prompt to emphasize running tests before committing. Consider adding test command examples to task descriptions.',
    });
  }

  // 3. Low completion rate
  if (summary.completionRate < 50 && summary.totalRuns >= 5) {
    const errorPct = Math.round((summary.errorRuns / summary.totalRuns) * 100);
    const maxIterPct = Math.round((summary.maxIterationsRuns / summary.totalRuns) * 100);
    insights.push({
      id: 'low-completion-rate',
      type: 'warning',
      lens: 'Speed',
      title: `Only ${summary.completionRate}% of pipeline runs complete successfully`,
      description: `Out of ${summary.totalRuns} pipeline runs: ${summary.completedRuns} completed (${summary.completionRate}%), ${summary.errorRuns} errored (${errorPct}%), ${summary.maxIterationsRuns} hit max iterations (${maxIterPct}%). A healthy pipeline should complete >70% of runs.`,
      action: 'Investigate error-state runs for common failure patterns. For max-iterations runs, consider increasing iteration limits or improving agent prompts to converge faster.',
    });
  }

  // 4. Stage bottleneck
  if (summary.stageAvgs.length > 0) {
    const slowest = summary.stageAvgs[0];
    if (slowest.avgSeconds > 300) { // > 5 minutes average
      const mins = Math.round(slowest.avgSeconds / 60);
      insights.push({
        id: 'stage-bottleneck',
        type: 'info',
        lens: 'Speed',
        title: `"${slowest.name}" stage averages ${mins} minutes — slowest pipeline stage`,
        description: `The "${slowest.name}" stage averages ${mins} minutes across ${slowest.count} runs. ${summary.stageAvgs.slice(1, 4).map(s => `"${s.name}": ${Math.round(s.avgSeconds / 60)}m`).join(', ')}. Long stages increase token cost due to context accumulation.`,
        action: 'Consider splitting large tasks in this stage, or check if the stage is doing unnecessary work (e.g., reading too many files, running full test suites instead of targeted tests).',
      });
    }
  }

  // 5. Error pattern
  if (summary.errorRuns > 0 && (summary.errorRuns / summary.totalRuns) > 0.3) {
    const errorExamples = runs.filter(r => r.state === 'error').slice(0, 5);
    const zeroTaskErrors = errorExamples.filter(r => r.taskCount === 0);
    const errorPct = Math.round((summary.errorRuns / summary.totalRuns) * 100);
    const detail = zeroTaskErrors.length > 0
      ? `${zeroTaskErrors.length} of ${summary.errorRuns} errors happened before any tasks were parsed (likely issue parsing or validation failures).`
      : `Errors occurred during task execution.`;
    insights.push({
      id: 'error-pattern',
      type: 'warning',
      lens: 'Quality',
      title: `${errorPct}% of pipeline runs end in error state`,
      description: `${summary.errorRuns} out of ${summary.totalRuns} runs ended in error. ${detail} Error examples: ${errorExamples.map(r => `#${r.issue}`).join(', ')}.`,
      action: 'Check orchestrator logs for the error-state runs. Zero-task errors usually mean issue parsing failed (malformed task list). Execution errors may need better error handling in the orchestrator.',
    });
  }

  return insights;
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  // 1. Short, vague messages that cost a lot
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const examples = [...new Set(shortExpensive.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      lens: 'Cost',
      title: 'Short, vague messages are costing you the most',
      description: `${shortExpensive.length} times you sent a short message like ${examples.map(e => '"' + e + '"').join(', ')} -- and each time, Claude used over 100K tokens to respond. That adds up to ${fmt(totalWasted)} tokens total. When you say just "Yes" or "Do it", Claude doesn't know exactly what you want, so it tries harder -- reading more files, running more tools, making more attempts. Each of those steps re-sends the entire conversation, which multiplies the cost.`,
      action: 'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests." It gives Claude a clear target, so it finishes faster and uses fewer tokens.',
    });
  }

  // 2. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: 'context-growth',
        type: 'warning',
        lens: 'Cost',
        title: 'The longer you chat, the more each message costs',
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, Claude re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because Claude is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives Claude a clean slate instead of re-reading hundreds of old messages.',
      });
    }
  }

  // 3. Marathon conversations
  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      lens: 'Cost',
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 200 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages. Long conversations aren't always bad, but they're disproportionately expensive because of how context builds up.`,
      action: 'Try keeping one conversation per task. When a conversation starts drifting into different topics, that is a good time to start a new one.',
    });
  }

  // 4. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        lens: 'Cost',
        title: `${outputPct.toFixed(1)}% of your tokens are Claude actually writing`,
        description: `Here's something surprising: out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Claude writing responses. The other ${(100 - outputPct).toFixed(1)}% is Claude re-reading your conversation history, files, and context before each response. This means the biggest factor in token usage isn't how much Claude writes -- it's how long your conversations are.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers. A 20-message conversation costs far less than a 200-message one, even if the total output is similar.',
      });
    }
  }

  // 5. Day-of-week pattern
  if (sessions.length >= 10) {
    const dayOfWeekMap = {};
    for (const s of sessions) {
      if (!s.timestamp) continue;
      const d = new Date(s.timestamp);
      const day = d.getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += s.totalTokens;
      dayOfWeekMap[day].sessions += 1;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({ day: dayNames[d], ...v, avg: v.tokens / v.sessions }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        lens: 'Cost',
        title: `You use Claude the most on ${busiest.day}s`,
        description: `Your ${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s. This could mean you tackle bigger tasks on ${busiest.day}s, or your conversations tend to run longer.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch -- Opus used for simple conversations
  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce((s, ses) => s + ses.totalTokens, 0);
      const examples = simpleOpus.slice(0, 3).map(s => '"' + s.firstPrompt.substring(0, 40) + '"').join(', ');
      insights.push({
        id: 'model-mismatch',
        type: 'warning',
        lens: 'Cost',
        title: `${simpleOpus.length} simple conversations used Opus unnecessarily`,
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus: ${examples}. Opus is the most capable model but also the most expensive. For quick questions and small tasks, Sonnet or Haiku would give similar results at a fraction of the cost.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes, architecture decisions, or tricky debugging.',
      });
    }
  }

  // 7. Tool-heavy conversations
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = s.queries.filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
      const avgRatio = toolHeavy.reduce((s, ses) => {
        const userMsgs = ses.queries.filter(q => q.userPrompt).length;
        return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
      }, 0) / toolHeavy.length;
      insights.push({
        id: 'tool-heavy',
        type: 'info',
        lens: 'Cost',
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than messages`,
        description: `In these conversations, Claude made ~${Math.round(avgRatio)} tool calls for every message you sent. Each tool call (reading files, running commands, searching code) is a full round trip that re-reads the entire conversation. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action: 'Point Claude to specific files and line numbers when you can. "Fix the bug in src/auth.js line 42" triggers fewer tool calls than "fix the login bug" where Claude has to search for the right file first.',
      });
    }
  }

  // 8. One project dominates usage
  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
      if (pct >= 60) {
        const projName = topProject.replace(/^C--Users-[^-]+-?/, '').replace(/^Projects-?/, '').replace(/-/g, '/') || '~';
        insights.push({
          id: 'project-dominance',
          type: 'info',
          lens: 'Cost',
          title: `${pct}% of your tokens went to one project: ${projName}`,
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total. That is ${pct}% of all your usage. The next closest project used ${fmt(sorted[1][1])} tokens.`,
          action: 'Not necessarily a problem, but worth knowing. If this project has long-running conversations, breaking them into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  // 9. Conversation efficiency -- short vs long conversations cost per message
  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSessions2 = sessions.filter(s => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(shortSessions.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / shortSessions.length);
      const longAvg = Math.round(longSessions2.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / longSessions2.length);
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          lens: 'Cost',
          title: `Each message costs ${ratio}x more in long conversations`,
          description: `In your short conversations (under 15 messages), each message costs ~${fmt(shortAvg)} tokens. In your long ones (80+ messages), each message costs ~${fmt(longAvg)} tokens. That is ${ratio}x more per message, because Claude re-reads the entire history every turn.`,
          action: 'This is the single biggest lever for reducing token usage. Start fresh conversations more often. A 5-conversation workflow costs far less than one 500-message marathon.',
        });
      }
    }
  }

  // 10. Heavy context on first message (large CLAUDE.md or system prompts)
  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter(s => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) / heavyStarts.length);
      const totalOverhead = heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0);
      insights.push({
        id: 'heavy-context',
        type: 'info',
        lens: 'Cost',
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. Across all of them, that is ${fmt(totalOverhead)} tokens just on setup -- and this context gets re-read with every message.`,
        action: 'Keep your CLAUDE.md files concise. Remove sections you rarely need. A smaller starting context compounds into savings across every message in the conversation.',
      });
    }
  }

  return insights;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

module.exports = { parseAllSessions };

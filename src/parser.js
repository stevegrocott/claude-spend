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

function normalizeProjectPath(projectDir) {
  // Normalize worktree paths matching pattern *-logs-implement-issue-* back to parent project
  const match = projectDir.match(/^(.+?)-logs-implement-issue-.+$/);
  if (match) {
    return match[1];
  }
  return projectDir;
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
        project: normalizeProjectPath(projectDir),
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

  // Generate per-lens recommendations
  const recommendations = generateRecommendations(sessions, allPrompts, grandTotals, orchestrator);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights: [...insights, ...orchestratorInsights],
    orchestrator,
    recommendations,
  };
}

function emptySummary() {
  return { totalRuns: 0, completedRuns: 0, errorRuns: 0, maxIterationsRuns: 0, completionRate: 0, avgQualityIterations: 0, avgTestIterations: 0, stageAvgs: [], topChurners: [], totalModelUsage: {}, escalationCount: 0, runsWithEscalations: 0, allEscalations: [], stageModelTotals: {} };
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
        const runDir = path.join(logsDir, entry);
        const statusPath = path.join(runDir, 'status.json');
        if (!fs.existsSync(statusPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
          const stages = raw.stages || {};

          // Calculate stage durations from status.json timestamps
          const stageDurations = {};
          for (const [name, stage] of Object.entries(stages)) {
            if (stage.started_at && stage.completed_at) {
              stageDurations[name] = (new Date(stage.completed_at) - new Date(stage.started_at)) / 1000;
            }
          }

          // Read metrics.json if present alongside status.json
          const metricsPath = path.join(runDir, 'metrics.json');
          let metrics = null;
          if (fs.existsSync(metricsPath)) {
            try {
              metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
            } catch {
              // Skip malformed metrics.json
            }
          }

          // Merge per-stage durations from metrics.json (may be more detailed)
          if (metrics && metrics.stages) {
            for (const [name, stageMetrics] of Object.entries(metrics.stages)) {
              if (stageMetrics.duration_seconds != null) {
                stageDurations[name] = stageMetrics.duration_seconds;
              }
            }
          }

          // Extract model usage from metrics.json
          const modelUsage = {};
          if (metrics && metrics.total_model_usage) {
            for (const [model, usage] of Object.entries(metrics.total_model_usage)) {
              modelUsage[model] = {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
              };
            }
          } else if (metrics && metrics.stages) {
            // Aggregate model usage across stages
            for (const stageMetrics of Object.values(metrics.stages)) {
              if (!stageMetrics.model_usage) continue;
              for (const [model, usage] of Object.entries(stageMetrics.model_usage)) {
                if (!modelUsage[model]) modelUsage[model] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
                modelUsage[model].inputTokens += usage.input_tokens || 0;
                modelUsage[model].outputTokens += usage.output_tokens || 0;
                modelUsage[model].totalTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
              }
            }
          }

          // Extract escalation events from metrics.json or status.json
          const escalations = [];
          const rawEscalations = (metrics && metrics.escalations) || raw.escalations || [];
          for (const esc of rawEscalations) {
            escalations.push({
              taskId: esc.task_id || null,
              fromModel: esc.from_model || null,
              toModel: esc.to_model || null,
              reason: esc.reason || null,
              stage: esc.stage || null,
              timestamp: esc.timestamp || null,
            });
          }

          // Per-stage model breakdown from metrics.json
          const stageModelUsage = {};
          if (metrics && metrics.stages) {
            for (const [stageName, stageMetrics] of Object.entries(metrics.stages)) {
              if (stageMetrics.model_usage) {
                stageModelUsage[stageName] = {};
                for (const [model, usage] of Object.entries(stageMetrics.model_usage)) {
                  stageModelUsage[stageName][model] = {
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0,
                    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                  };
                }
              }
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
            modelUsage,
            stageModelUsage,
            escalations,
            hasMetrics: metrics !== null,
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

  // Aggregate model usage across all runs (from metrics.json data)
  const totalModelUsage = {};
  for (const run of validRuns) {
    for (const [model, usage] of Object.entries(run.modelUsage || {})) {
      if (!totalModelUsage[model]) totalModelUsage[model] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, runCount: 0 };
      totalModelUsage[model].inputTokens += usage.inputTokens;
      totalModelUsage[model].outputTokens += usage.outputTokens;
      totalModelUsage[model].totalTokens += usage.totalTokens;
      totalModelUsage[model].runCount += 1;
    }
  }

  // Aggregate escalation events across all runs
  const allEscalations = validRuns.flatMap(r => (r.escalations || []).map(e => ({ ...e, project: r.project, issue: r.issue })));
  const escalationCount = allEscalations.length;
  const runsWithEscalations = validRuns.filter(r => (r.escalations || []).length > 0).length;

  // Stage-level model diversity (which stages use expensive models)
  const stageModelTotals = {};
  for (const run of validRuns) {
    for (const [stageName, stageModels] of Object.entries(run.stageModelUsage || {})) {
      if (!stageModelTotals[stageName]) stageModelTotals[stageName] = {};
      for (const [model, usage] of Object.entries(stageModels)) {
        if (!stageModelTotals[stageName][model]) stageModelTotals[stageName][model] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        stageModelTotals[stageName][model].inputTokens += usage.inputTokens;
        stageModelTotals[stageName][model].outputTokens += usage.outputTokens;
        stageModelTotals[stageName][model].totalTokens += usage.totalTokens;
      }
    }
  }

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
      totalModelUsage,
      escalationCount,
      runsWithEscalations,
      allEscalations,
      stageModelTotals,
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
      lens: 'quality',
      type: 'warning',
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
      lens: 'quality',
      type: 'warning',
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
      lens: 'quality',
      type: 'warning',
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
        lens: 'speed',
        type: 'info',
        title: `"${slowest.name}" stage averages ${mins} minutes — slowest pipeline stage`,
        description: `The "${slowest.name}" stage averages ${mins} minutes across ${slowest.count} runs. ${summary.stageAvgs.slice(1, 4).map(s => `"${s.name}": ${Math.round(s.avgSeconds / 60)}m`).join(', ')}. Long stages increase token cost due to context accumulation.`,
        action: 'Consider splitting large tasks in this stage, or check if the stage is doing unnecessary work (e.g., reading too many files, running full test suites instead of targeted tests).',
      });
    }
  }

  // 5a. Task throughput — completed runs per week
  const completedWithDate = runs.filter(r => r.state === 'completed' && r.date);
  if (completedWithDate.length >= 3) {
    const weekMap = {};
    for (const run of completedWithDate) {
      const d = new Date(run.date);
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      weekMap[key] = (weekMap[key] || 0) + 1;
    }
    const weekCounts = Object.values(weekMap);
    const avgPerWeek = (weekCounts.reduce((s, v) => s + v, 0) / weekCounts.length).toFixed(1);
    const recentWeeks = Object.entries(weekMap).sort().slice(-4);
    const recentAvg = recentWeeks.length > 0
      ? (recentWeeks.reduce((s, [, v]) => s + v, 0) / recentWeeks.length).toFixed(1)
      : avgPerWeek;
    insights.push({
      id: 'task-throughput',
      lens: 'speed',
      type: 'info',
      title: `Pipeline completes ~${avgPerWeek} issues/week on average`,
      description: `Out of ${summary.totalRuns} total runs, ${summary.completedRuns} completed successfully across ${weekCounts.length} active weeks. Overall average: ${avgPerWeek} completions/week. Recent ${recentWeeks.length}-week average: ${recentAvg}/week. ${parseFloat(recentAvg) > parseFloat(avgPerWeek) ? 'Throughput is trending up.' : parseFloat(recentAvg) < parseFloat(avgPerWeek) ? 'Throughput has slowed recently.' : 'Throughput is stable.'}`,
      action: parseFloat(recentAvg) < parseFloat(avgPerWeek)
        ? 'Recent slowdown may reflect harder issues, higher error rates, or more quality churn. Compare recent error and iteration counts against historical averages.'
        : null,
    });
  }

  // 5b. First-pass approval rate
  const runsWithReviews = runs.filter(r => r.qualityIterations > 0 || r.prReviewIterations > 0);
  if (runsWithReviews.length >= 3) {
    const firstPassRuns = runsWithReviews.filter(r => r.qualityIterations <= 1 && r.prReviewIterations <= 1);
    const rate = Math.round((firstPassRuns.length / runsWithReviews.length) * 100);
    const multipleQuality = runsWithReviews.filter(r => r.qualityIterations > 2);
    const worstList = multipleQuality.slice(0, 3).map(r => `#${r.issue} (${r.qualityIterations} quality, ${r.prReviewIterations} PR)`).join(', ');
    insights.push({
      id: 'first-pass-approval-rate',
      lens: 'quality',
      type: rate < 50 ? 'warning' : rate < 75 ? 'info' : 'neutral',
      title: `${rate}% of reviewed pipeline runs pass quality review on the first attempt`,
      description: `Of ${runsWithReviews.length} runs with quality or PR review data, ${firstPassRuns.length} passed with 1 or fewer iterations (${rate}%). A high first-pass rate means implementers understand the quality bar. A low rate means repeated re-review cycles — each costing a full agent invocation. ${multipleQuality.length > 0 ? `Worst offenders: ${worstList}.` : ''}`,
      action: rate < 75
        ? 'Improve first-pass rate by: (1) adding concrete quality criteria to implementer prompts, (2) providing code style examples, (3) ensuring task descriptions are specific about expected output format.'
        : null,
    });
  }

  // 5c. Parallel speedup ratio — comparing multi-task vs single-task run durations
  const implementRuns = runs.filter(r => r.logType === 'implement-issue' && r.taskCount > 0);
  const runsWithDuration = implementRuns.map(r => ({
    ...r,
    totalDuration: Object.values(r.stageDurations).reduce((s, v) => s + v, 0),
  })).filter(r => r.totalDuration > 30);

  const singleTaskRuns = runsWithDuration.filter(r => r.taskCount === 1);
  const multiTaskRuns = runsWithDuration.filter(r => r.taskCount > 1);

  if (singleTaskRuns.length >= 2 && multiTaskRuns.length >= 2) {
    const avgSingleDuration = singleTaskRuns.reduce((s, r) => s + r.totalDuration, 0) / singleTaskRuns.length;
    const avgMultiTasks = multiTaskRuns.reduce((s, r) => s + r.taskCount, 0) / multiTaskRuns.length;
    const avgMultiDuration = multiTaskRuns.reduce((s, r) => s + r.totalDuration, 0) / multiTaskRuns.length;
    const theoreticalSeq = avgMultiTasks * avgSingleDuration;
    const speedupRatio = Math.round((theoreticalSeq / Math.max(avgMultiDuration, 1)) * 10) / 10;
    if (speedupRatio > 1.2) {
      const timeSavedMin = Math.round((theoreticalSeq - avgMultiDuration) / 60);
      insights.push({
        id: 'parallel-speedup-ratio',
        lens: 'speed',
        type: 'info',
        title: `Parallel task execution is ${speedupRatio}x faster than sequential would be`,
        description: `Single-task runs average ${Math.round(avgSingleDuration / 60)} minutes. Multi-task runs average ${Math.round(avgMultiTasks)} tasks but only take ${Math.round(avgMultiDuration / 60)} minutes — ${speedupRatio}x faster than running those tasks one at a time would take. That saves ~${timeSavedMin} minutes per multi-task run. Across ${multiTaskRuns.length} such runs, parallel execution has saved substantial pipeline time.`,
        action: 'Break large issues into independent parallel tasks to maximize this speedup. Tasks with shared state or sequential dependencies cannot be parallelized, but independent tasks (separate files, separate modules) can.',
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
      lens: 'quality',
      type: 'warning',
      title: `${errorPct}% of pipeline runs end in error state`,
      description: `${summary.errorRuns} out of ${summary.totalRuns} runs ended in error. ${detail} Error examples: ${errorExamples.map(r => `#${r.issue}`).join(', ')}.`,
      action: 'Check orchestrator logs for the error-state runs. Zero-task errors usually mean issue parsing failed (malformed task list). Execution errors may need better error handling in the orchestrator.',
    });
  }

  // 6. Model escalation pattern (from metrics.json)
  if (summary.escalationCount > 0 && summary.runsWithEscalations >= 2) {
    const escalPct = Math.round((summary.runsWithEscalations / summary.totalRuns) * 100);
    // Find most common escalation direction
    const escalPairs = {};
    for (const esc of summary.allEscalations) {
      if (esc.fromModel && esc.toModel) {
        const key = `${esc.fromModel} → ${esc.toModel}`;
        escalPairs[key] = (escalPairs[key] || 0) + 1;
      }
    }
    const topPair = Object.entries(escalPairs).sort((a, b) => b[1] - a[1])[0];
    const pairDesc = topPair ? ` Most common: ${topPair[0]} (${topPair[1]} times).` : '';
    insights.push({
      id: 'escalation-pattern',
      type: 'warning',
      title: `Model escalations in ${escalPct}% of pipeline runs`,
      description: `${summary.escalationCount} escalation events detected across ${summary.runsWithEscalations} of ${summary.totalRuns} runs.${pairDesc} Escalations happen when a task is reassigned to a more expensive model mid-run, which multiplies token cost for that stage.`,
      action: 'Review tasks that trigger escalations — they may need better upfront model assignment. If the same task type consistently escalates from haiku to sonnet, set its default agent to sonnet from the start.',
    });
  }

  // 7. Stage model cost breakdown (from metrics.json)
  if (Object.keys(summary.stageModelTotals).length > 0) {
    // Find which stage uses the most expensive model tokens
    const stageOpusCost = [];
    for (const [stageName, modelMap] of Object.entries(summary.stageModelTotals)) {
      const opusTokens = Object.entries(modelMap)
        .filter(([model]) => model.includes('opus'))
        .reduce((s, [, u]) => s + u.totalTokens, 0);
      if (opusTokens > 0) {
        stageOpusCost.push({ stageName, opusTokens });
      }
    }
    stageOpusCost.sort((a, b) => b.opusTokens - a.opusTokens);
    if (stageOpusCost.length > 0 && stageOpusCost[0].opusTokens > 100_000) {
      const top = stageOpusCost[0];
      insights.push({
        id: 'stage-model-cost',
        type: 'info',
        title: `"${top.stageName}" stage uses the most Opus tokens across pipeline runs`,
        description: `The "${top.stageName}" stage has consumed ${fmt(top.opusTokens)} Opus tokens across all runs. Other high-Opus stages: ${stageOpusCost.slice(1, 3).map(s => `"${s.stageName}" (${fmt(s.opusTokens)})`).join(', ') || 'none'}. Opus costs 5-10x more than Sonnet per token.`,
        action: `Consider whether the "${top.stageName}" stage truly needs Opus, or if Sonnet would be sufficient. Review the agent prompt for this stage to see if it can be simplified.`,
      });
    }
  }

  return insights;
}

// Uses PRICING constant defined at top of file

function modelTier(model) {
  if (!model) return null;
  if (model.includes('opus'))   return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku'))  return 'haiku';
  return null;
}

function estimateCost(inputTokens, outputTokens, tier) {
  const p = PRICING[tier] || PRICING.sonnet;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

function fmtDollars(n) {
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  return '$' + n.toFixed(4);
}

/**
 * Generate per-lens actionable recommendations from usage data.
 * Returns { model: [...], context: [...], conversation: [...], pipeline: [...] }
 * Each entry: { text, detail, saving }
 */
function generateRecommendations(sessions, allPrompts, totals, orchestrator) {
  const recs = { model: [], context: [], conversation: [], pipeline: [] };

  // ── MODEL LENS ──────────────────────────────────────────────────────────────
  // 1. Opus sessions that don't need Opus (simple tasks)
  const opusSessions = sessions.filter(s => modelTier(s.model) === 'opus');
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 15 && s.totalTokens < 300_000);
    if (simpleOpus.length >= 2) {
      const inputTokens = simpleOpus.reduce((s, ses) => s + ses.inputTokens, 0);
      const outputTokens = simpleOpus.reduce((s, ses) => s + ses.outputTokens, 0);
      const opusCost  = estimateCost(inputTokens, outputTokens, 'opus');
      const sonnetCost = estimateCost(inputTokens, outputTokens, 'sonnet');
      const savings = opusCost - sonnetCost;
      recs.model.push({
        text: `Switch ${simpleOpus.length} simple sessions from Opus→Sonnet to save ~${fmtDollars(savings)}`,
        detail: `${simpleOpus.length} sessions had <15 queries but used expensive Opus. Example: "${(simpleOpus[0].firstPrompt || '').substring(0, 60)}". Sonnet handles these tasks equally well.`,
        saving: savings,
      });
    }
  }

  // 2. CLAUDE.md / context overhead cost per session
  const heavyStarts = sessions.filter(s => s.queries && s.queries[0] && s.queries[0].inputTokens > 50_000);
  if (heavyStarts.length >= 3) {
    const avgStartInput = heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) / heavyStarts.length;
    const totalContextCost = heavyStarts.reduce((s, ses) => s + estimateCost(ses.queries[0].inputTokens, 0, modelTier(ses.model) || 'sonnet'), 0);
    const perSession = totalContextCost / heavyStarts.length;
    recs.model.push({
      text: `Your CLAUDE.md costs ~${fmtDollars(perSession)} per session in context overhead`,
      detail: `Sessions start with ~${fmt(Math.round(avgStartInput))} tokens before your first message. Trim unused CLAUDE.md sections to compound savings across every conversation.`,
      saving: totalContextCost,
    });
  }

  // 3. Model mix: if >80% tokens on one model, mention cheaper alternatives exist
  if (sessions.length >= 5) {
    const tierTokens = { opus: 0, sonnet: 0, haiku: 0 };
    for (const s of sessions) {
      const t = modelTier(s.model);
      if (t) tierTokens[t] += s.totalTokens;
    }
    const total = tierTokens.opus + tierTokens.sonnet + tierTokens.haiku;
    if (total > 0 && tierTokens.opus / total > 0.5) {
      const opusPct = Math.round(tierTokens.opus / total * 100);
      const opusCost = estimateCost(
        sessions.filter(s => modelTier(s.model) === 'opus').reduce((s, ses) => s + ses.inputTokens, 0),
        sessions.filter(s => modelTier(s.model) === 'opus').reduce((s, ses) => s + ses.outputTokens, 0),
        'opus'
      );
      const savings = opusCost * 0.4; // rough: shift 40% to sonnet
      if (recs.model.length < 3) {
        recs.model.push({
          text: `${opusPct}% of tokens use Opus — shifting routine tasks to Sonnet saves ~${fmtDollars(savings)}`,
          detail: `Opus is ideal for complex reasoning but over-powered for file edits, linting, and one-shot tasks. Use /model to switch for routine work.`,
          saving: savings,
        });
      }
    }
  }

  // ── CONTEXT LENS ─────────────────────────────────────────────────────────────
  // 1. Vague/short prompts that trigger expensive tool chains
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const worst = [...shortExpensive].sort((a, b) => b.totalTokens - a.totalTokens)[0];
    const totalWastedInput = shortExpensive.reduce((s, p) => s + p.inputTokens, 0);
    const totalWastedOutput = shortExpensive.reduce((s, p) => s + p.outputTokens, 0);
    const worstTier = modelTier(worst.model) || 'sonnet';
    const wastedCost = estimateCost(totalWastedInput, totalWastedOutput, worstTier);
    recs.context.push({
      text: `"${worst.prompt.trim().substring(0, 35)}" cost ${fmt(worst.totalTokens)} tokens — specific prompts cut this 50-80%`,
      detail: `${shortExpensive.length} short messages triggered expensive tool chains (total ~${fmtDollars(wastedCost)} estimated). Saying "Yes, update auth.js line 42 and run tests" beats "Yes".`,
      saving: wastedCost * 0.6,
    });
  }

  // 2. Conversation length efficiency gap
  if (sessions.length >= 10) {
    const shortSess = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSess  = sessions.filter(s => s.queryCount > 80);
    if (shortSess.length >= 3 && longSess.length >= 2) {
      const shortAvg = shortSess.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / shortSess.length;
      const longAvg  = longSess.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / longSess.length;
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        recs.context.push({
          text: `Long conversations cost ${ratio}x more per message — start a fresh session per task`,
          detail: `Short sessions average ~${fmt(Math.round(shortAvg))} tokens/msg vs ~${fmt(Math.round(longAvg))} in long ones. Every message re-reads the full history.`,
          saving: null,
        });
      }
    }
  }

  // 3. Input-heavy ratio (most tokens are re-reads)
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 3) {
      recs.context.push({
        text: `${outputPct.toFixed(1)}% of tokens are actual responses — shorter sessions = bigger savings than shorter answers`,
        detail: `The other ${(100 - outputPct).toFixed(1)}% is Claude re-reading context. Session length matters far more than response length.`,
        saving: null,
      });
    }
  }

  // ── CONVERSATION LENS ────────────────────────────────────────────────────────
  // 1. Marathon sessions dominating spend
  const marathonSessions = sessions.filter(s => s.queryCount > 200);
  if (marathonSessions.length >= 2) {
    const marathonTokens = marathonSessions.reduce((s, ses) => s + ses.totalTokens, 0);
    const marathonPct = Math.round(marathonTokens / Math.max(totals.totalTokens, 1) * 100);
    const topMarathon = [...marathonSessions].sort((a, b) => b.totalTokens - a.totalTokens)[0];
    recs.conversation.push({
      text: `${marathonSessions.length} marathon sessions (200+ msgs) consumed ${marathonPct}% of total tokens`,
      detail: `Biggest: "${(topMarathon.firstPrompt || '').substring(0, 60)}" with ${topMarathon.queryCount} messages. Break large tasks into focused sessions to reset context.`,
      saving: null,
    });
  }

  // 2. Tool-heavy sessions
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = (s.queries || []).filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 4;
    });
    if (toolHeavy.length >= 2) {
      const avgRatio = Math.round(toolHeavy.reduce((s, ses) => {
        const u = (ses.queries || []).filter(q => q.userPrompt).length;
        return s + (ses.queryCount - u) / Math.max(u, 1);
      }, 0) / toolHeavy.length);
      recs.conversation.push({
        text: `${toolHeavy.length} sessions had ${avgRatio}x more tool calls than messages — point Claude to specific files`,
        detail: `Saying "Fix auth.js:42" triggers fewer tool calls than "fix the login bug" (which causes Claude to search). Each tool call re-reads the full conversation.`,
        saving: null,
      });
    }
  }

  // 3. Project dominance
  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = Math.round((topTokens / Math.max(totals.totalTokens, 1)) * 100);
      if (pct >= 60) {
        const shortName = topProject.replace(/^[A-Za-z]--/, '').replace(/^Users-[^-]+-/, '').replace(/-/g, '/') || topProject;
        recs.conversation.push({
          text: `"${shortName.substring(0, 40)}" uses ${pct}% of tokens — optimise here first for biggest impact`,
          detail: `Applying shorter sessions and specific prompts to this project alone would meaningfully reduce your total spend.`,
          saving: null,
        });
      }
    }
  }

  // ── PIPELINE LENS ────────────────────────────────────────────────────────────
  if (orchestrator && orchestrator.summary && orchestrator.summary.totalRuns >= 3) {
    const s = orchestrator.summary;

    // 1. Quality loop churn — recommend fixing implementer prompt
    if (s.avgQualityIterations > 2) {
      const worstChurners = (s.topChurners || []).filter(r => r.qualityIterations > 3).slice(0, 3);
      const suffix = worstChurners.length > 0
        ? ` Worst: ${worstChurners.map(r => `#${r.issue} (${r.qualityIterations}x)`).join(', ')}`
        : '';
      recs.pipeline.push({
        text: `Quality loop averages ${s.avgQualityIterations}x — tighten implementer prompt to converge in 1-2 iterations`,
        detail: `Ideal is 1-2 quality iterations per run. Each extra iteration adds a full review+fix cycle.${suffix}`,
        saving: null,
      });
    }

    // 2. Test loop churn — add "run tests before committing"
    if (s.avgTestIterations > 2) {
      recs.pipeline.push({
        text: `Test loop averages ${s.avgTestIterations}x — add "run tests before committing" to implementer prompt`,
        detail: `Each test iteration means implementation shipped without passing tests. A single prompt line prevents most failures.`,
        saving: null,
      });
    }

    // 3. Haiku escalation pattern — detect if haiku is used but quality fails consistently
    const { runs } = orchestrator;
    const haikusRuns = (runs || []).filter(r => {
      // Heuristic: runs with high quality iterations likely had model escalation issues
      return r.qualityIterations > 3;
    });
    if (haikusRuns.length >= 2 && s.avgQualityIterations > 2) {
      const escalationPct = Math.round(haikusRuns.length / Math.max(s.totalRuns, 1) * 100);
      recs.pipeline.push({
        text: `${escalationPct}% of runs churn 3+ quality loops — route complex tasks directly to Sonnet`,
        detail: `Runs with ${3}+ quality iterations likely needed a more capable model from the start. Routing complex tasks to Sonnet reduces review cycles.`,
        saving: null,
      });
    } else if (s.stageAvgs && s.stageAvgs.length > 0 && s.stageAvgs[0].avgSeconds > 300) {
      // Stage bottleneck fallback
      const slowest = s.stageAvgs[0];
      const mins = Math.round(slowest.avgSeconds / 60);
      recs.pipeline.push({
        text: `"${slowest.name}" stage averages ${mins}m — split large tasks or cache file reads`,
        detail: `Long stages accumulate context per turn, increasing token cost. Breaking tasks or pre-loading key files reduces per-turn reads.`,
        saving: null,
      });
    }

    // 4. Low completion rate
    if (s.completionRate < 50 && s.totalRuns >= 5 && recs.pipeline.length < 3) {
      const errorPct = Math.round((s.errorRuns / s.totalRuns) * 100);
      recs.pipeline.push({
        text: `Only ${s.completionRate}% of runs complete — investigate error patterns in orchestrator logs`,
        detail: `${s.errorRuns} of ${s.totalRuns} runs ended in error. Zero-task errors often mean issue parsing failed; execution errors need better agent error handling.`,
        saving: null,
      });
    }
  }

  // Trim to 3 per lens
  for (const key of Object.keys(recs)) recs[key] = recs[key].slice(0, 3);
  return recs;
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
      lens: 'cost',
      type: 'warning',
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
        lens: 'cost',
        type: 'warning',
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
      lens: 'cost',
      type: 'info',
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
        lens: 'cost',
        type: 'info',
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
        lens: 'cost',
        type: 'neutral',
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
        lens: 'cost',
        type: 'warning',
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
        lens: 'speed',
        type: 'info',
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
          lens: 'cost',
          type: 'info',
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
          lens: 'cost',
          type: 'warning',
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
        lens: 'cost',
        type: 'info',
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. Across all of them, that is ${fmt(totalOverhead)} tokens just on setup -- and this context gets re-read with every message.`,
        action: 'Keep your CLAUDE.md files concise. Remove sections you rarely need. A smaller starting context compounds into savings across every message in the conversation.',
      });
    }
  }

  // 11. Wasted escalation cost — Opus used where Sonnet would suffice
  const calcCost = (inp, out, tier) => {
    const p = PRICING[tier];
    return p ? (inp * p.input + out * p.output) / 1_000_000 : 0;
  };
  const escalatedSessions = sessions.filter(s =>
    s.model.includes('opus') && s.queryCount < 20 && s.totalTokens < 500_000
  );
  if (escalatedSessions.length >= 2) {
    let totalWasted = escalatedSessions.reduce((sum, s) => {
      return sum + calcCost(s.inputTokens, s.outputTokens, 'opus') - calcCost(s.inputTokens, s.outputTokens, 'sonnet');
    }, 0);
    if (totalWasted > 0.5) {
      const examples = escalatedSessions.slice(0, 3).map(s => '"' + s.firstPrompt.substring(0, 40) + '"').join(', ');
      insights.push({
        id: 'wasted-escalation-cost',
        lens: 'cost',
        type: 'warning',
        title: `~$${totalWasted.toFixed(2)} extra spent using Opus for simple tasks`,
        description: `${escalatedSessions.length} sessions used Opus for short, lightweight work (under 20 messages, under 500K tokens), costing ~$${totalWasted.toFixed(2)} more than if they had run on Sonnet. Opus is ~5x more expensive per token than Sonnet. Examples: ${examples}.`,
        action: 'Switch to Sonnet for short tasks with /model sonnet. Reserve Opus for complex multi-file changes, deep architecture decisions, or difficult debugging where its extra reasoning power is needed.',
      });
    }
  }

  // 12. Scope creep indicator — Claude taking far more autonomous steps than prompted
  if (sessions.length >= 5) {
    const scopeCreepSessions = sessions.filter(s => {
      const userTurns = s.queries.filter(q => q.userPrompt).length;
      const continuations = s.queryCount - userTurns;
      return userTurns > 0 && continuations > userTurns * 4;
    });
    if (scopeCreepSessions.length >= 2) {
      const avgRatio = scopeCreepSessions.reduce((sum, s) => {
        const userTurns = Math.max(s.queries.filter(q => q.userPrompt).length, 1);
        return sum + (s.queryCount - userTurns) / userTurns;
      }, 0) / scopeCreepSessions.length;
      const totalScopeTokens = scopeCreepSessions.reduce((s, ses) => s + ses.totalTokens, 0);
      insights.push({
        id: 'scope-creep-indicator',
        lens: 'cost',
        type: 'warning',
        title: `${scopeCreepSessions.length} conversations show likely scope creep`,
        description: `In ${scopeCreepSessions.length} sessions, Claude made ~${Math.round(avgRatio)}x more autonomous steps than you prompted. For every message you sent, Claude took ~${Math.round(avgRatio)} additional unprompted actions. These ${scopeCreepSessions.length} sessions used ${fmt(totalScopeTokens)} tokens — Claude was likely doing unrequested work: refactoring untouched files, adding extra features, or exploring beyond the stated goal.`,
        action: 'Give Claude explicit stopping criteria: "Fix the null pointer in auth.js:42 and run unit tests, then stop." This tells Claude exactly when it is done, preventing it from autonomously extending the task.',
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

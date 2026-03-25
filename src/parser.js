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

// Task size story point values
const SIZE_POINTS = { S: 1, M: 3, L: 5 };

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

function parseTaskSummary(raw) {
  // If upstream provides task_summary, normalize field names
  if (raw.task_summary) {
    const ts = raw.task_summary;
    return {
      completed: ts.completed || { S: 0, M: 0, L: 0 },
      failed: ts.failed || { S: 0, M: 0, L: 0 },
      total: ts.total ?? (raw.tasks || []).length,
      storyPointsCompleted: ts.storyPointsCompleted ?? ts.sp_completed ?? 0,
      storyPointsTotal: ts.storyPointsTotal ?? ts.sp_total ?? 0,
    };
  }

  // Parse task descriptions for size markers
  const tasks = raw.tasks || [];
  const completed = { S: 0, M: 0, L: 0 };
  const failed = { S: 0, M: 0, L: 0 };
  let storyPointsCompleted = 0;
  let storyPointsTotal = 0;

  for (const task of tasks) {
    const sizeMatch = (task.description || '').match(/\*\*\((S|M|L)\)\*\*/);
    const size = sizeMatch ? sizeMatch[1] : 'S';
    const points = SIZE_POINTS[size];
    storyPointsTotal += points;

    if (task.status === 'completed') {
      completed[size]++;
      storyPointsCompleted += points;
    } else if (task.status === 'failed') {
      failed[size]++;
    }
  }

  return { completed, failed, total: tasks.length, storyPointsCompleted, storyPointsTotal };
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
  const pipelineDailyMap = {}; // pipeline-subagent tokens only, keyed by date
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
      let date = 'unknown';
      if (firstTimestamp) {
        const d = new Date(firstTimestamp);
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

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
      const promptStartIdx = allPrompts.length;
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

      const sessionType = categorizeSession({
        queryCount: queries.length,
        firstPrompt: firstPrompt.substring(0, 200),
      });

      // Tag prompts from this session with their type
      for (let pi = promptStartIdx; pi < allPrompts.length; pi++) {
        allPrompts[pi].sessionType = sessionType;
      }

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
        sessionType,
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

        // Pipeline-only daily token tracking
        if (sessionType === 'pipeline_subagent') {
          if (!pipelineDailyMap[date]) pipelineDailyMap[date] = 0;
          pipelineDailyMap[date] += totalTokens;
        }
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

  // Build pipeline-only daily usage for PP/100MT computation
  const pipelineDailyUsage = Object.entries(pipelineDailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, totalTokens]) => ({ date, totalTokens }));

  // Total pipeline tokens across all dates
  const pipelineTokens = pipelineDailyUsage.reduce((sum, d) => sum + d.totalTokens, 0);

  // Top 20 most expensive prompts per category (pipeline + interactive)
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const pipelinePrompts = allPrompts.filter(p => p.sessionType === 'pipeline_subagent').slice(0, 20);
  const interactivePrompts = allPrompts.filter(p => p.sessionType !== 'pipeline_subagent').slice(0, 20);
  const topPrompts = [...pipelinePrompts, ...interactivePrompts].sort((a, b) => b.totalTokens - a.totalTokens);

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
  orchestrator.summary.ppmtAnalysis = computePPMTAnalysis(orchestrator.runs.filter(r => r.state !== 'initializing' && r.state !== 'running'), pipelineDailyUsage);
  orchestrator.summary.ppmtAnalysis.pipelineTokens = pipelineTokens;
  orchestrator.summary.recommendations = generatePPMTRecommendations(orchestrator.summary.ppmtAnalysis);
  const orchestratorInsights = generateOrchestratorInsights(orchestrator);

  // Add pp100mt to each projectBreakdown entry using orchestrator projectYield data
  const projectYieldByName = {};
  for (const py of orchestrator.summary.ppmtAnalysis.projectYield || []) {
    projectYieldByName[py.project] = py;
  }
  // Build pipeline token map by project (from sessions)
  const pipelineTokensByProject = {};
  for (const s of sessions) {
    if (s.sessionType === 'pipeline_subagent') {
      pipelineTokensByProject[s.project] = (pipelineTokensByProject[s.project] || 0) + s.totalTokens;
    }
  }
  for (const entry of projectBreakdown) {
    const projPipelineTokens = pipelineTokensByProject[entry.project] || 0;
    // Match session project path to orchestrator project name (e.g., '-Users-x-projects-claude-spend' → 'claude-spend')
    const orchProject = Object.values(projectYieldByName).find(py => {
      const encoded = `-${py.project.replace(/\//g, '-')}`;
      return entry.project.endsWith(encoded);
    });
    const sp = orchProject ? orchProject.spCompleted : 0;
    entry.pp100mt = projPipelineTokens > 0
      ? Math.round((sp / (projPipelineTokens / 100_000_000)) * 100) / 100
      : 0;
  }

  const sessionEfficiency = computeSessionEfficiency(sessions);
  sessionEfficiency.recommendations = generateSessionRecommendations(sessionEfficiency);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights: [...insights, ...orchestratorInsights],
    orchestrator,
    sessionEfficiency,
  };
}

function emptySummary() {
  return { totalRuns: 0, completedRuns: 0, errorRuns: 0, maxIterationsRuns: 0, completionRate: 0, avgQualityIterations: 0, avgTestIterations: 0, stageAvgs: [], topChurners: [], totalModelUsage: {}, escalationCount: 0, runsWithEscalations: 0, allEscalations: [], stageModelTotals: {}, yieldByDay: [] };
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

  const logPatterns = ['logs/implement-issue', 'logs/test-fix-loop', 'logs/explore'];

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
            parseIssueCompleted: raw.stages?.parse_issue?.status === 'completed',
            date,
            dirName: entry,
            estimatedCost,
            taskSummary: parseTaskSummary(raw),
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
  const validRuns = runs.filter(r => r.state !== 'initializing' && r.state !== 'running');
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

  // Calculate velocity metrics (story points completed per day)
  const dailyVelocity = {};
  for (const run of validRuns) {
    if (run.date && run.taskSummary) {
      if (!dailyVelocity[run.date]) {
        dailyVelocity[run.date] = { spCompleted: 0, spTotal: 0 };
      }
      dailyVelocity[run.date].spCompleted += run.taskSummary.storyPointsCompleted || 0;
      dailyVelocity[run.date].spTotal += run.taskSummary.storyPointsTotal || 0;
    }
  }

  // Build velocityByDay with cumulative tracking and calculate stats in one pass
  let totalSP = 0, completedSP = 0;
  const velocityByDay = Object.entries(dailyVelocity)
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .reduce((acc, [date, data]) => {
      const cumulative = acc.length > 0 ? acc[acc.length - 1].cumulative + data.spCompleted : data.spCompleted;
      totalSP += data.spTotal;
      completedSP += data.spCompleted;
      acc.push({
        date,
        spCompleted: data.spCompleted,
        spTotal: data.spTotal,
        cumulative,
      });
      return acc;
    }, []);

  const avgSPPerDay = velocityByDay.length > 0 ? Math.round((completedSP / velocityByDay.length) * 10) / 10 : 0;
  const avgSPPerWeek = velocityByDay.length > 0 ? Math.round((completedSP / (velocityByDay.length / 7)) * 10) / 10 : 0;

  const velocityStats = {
    totalSP,
    completedSP,
    avgSPPerDay,
    avgSPPerWeek,
  };

  // yieldByDay: daily yield percentage (SP completed / SP total)
  const yieldByDay = Object.entries(dailyVelocity)
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, data]) => ({
      date,
      yieldPct: data.spTotal > 0 ? Math.round((data.spCompleted / data.spTotal) * 100) : 0,
      spCompleted: data.spCompleted,
      spTotal: data.spTotal,
    }));

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
      velocityByDay,
      velocityStats,
      yieldByDay,
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
      lens: 'cost',
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
        lens: 'cost',
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

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  // 1. Explore stage produces too many file candidates
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const avgTokens = Math.round(totalWasted / shortExpensive.length);
    insights.push({
      id: 'explore-stage-bloat',
      lens: 'cost',
      type: 'warning',
      title: `Explore stage searches too broadly — ${shortExpensive.length} queries averaged ${fmt(avgTokens)} tokens`,
      description: `${shortExpensive.length} short queries (like "Yes", "Do it") triggered wide-open explore patterns that scanned entire codebase. Each used 100K+ tokens searching for context. This suggests the explore skill has insufficient constraints and returns too many candidate files, forcing implement stage to re-read and filter.`,
      action: 'Refine explore skill: limit file candidates to 3-5 maximum, require specific path patterns in task description, or add "scope:" field to task template.',
    });
  }

  // 2. Implement stage context grows—tasks need to be split
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      insights.push({
        id: 'impl-context-growth',
        lens: 'cost',
        type: 'warning',
        title: `Implement stage context balloons ${avgGrowth}x over task lifetime — split tasks smaller`,
        description: `In ${growthData.length} runs, costs per turn grew ${avgGrowth}x from start to finish. This happens when implement stage tackles too much: context accumulates, re-reads get expensive, and later iterations become 10x costlier. Indicates tasks are defined too broadly or should be split into sub-tasks.`,
        action: 'Update task template in CLAUDE.md: require "Scope: Under 3 files" and "Done when: [specific criteria]". Split large refactors into file-focused sub-tasks.',
      });
    }
  }

  // 3. Pipeline accumulates large task sets—implement task batching
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'pipeline-batch-churn',
      lens: 'cost',
      type: 'warning',
      title: `${longCount} epic-scope runs used ${longPct}% of tokens — split or batch`,
      description: `${longCount} pipeline runs exceeded 200 turns each, consuming ${fmt(longTokens)} tokens (${longPct}% of total). Each turn accumulates context, compound re-reads, and drives up cost per iteration. Indicates implement stage is attempting multi-file refactors or cross-subsystem changes in single run.`,
      action: 'Implement task batching: split epic tasks into related sub-tasks (e.g., "fix auth module" → separate file changes). Or increase quality loop iteration limit in model-config.sh to converge faster.',
    });
  }

  // 4. Implement stage re-reads excessive context—enable file caching
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'impl-excessive-rereads',
        lens: 'speed',
        type: 'warning',
        title: `${outputPct.toFixed(1)}% of tokens are actual work — implement caching`,
        description: `${(100 - outputPct).toFixed(1)}% is context re-reading: same files loaded repeatedly across quality loop iterations. Each implement-check-fix cycle re-reads the entire codebase. This compounds with long tasks. File caching eliminates redundant reads and can save ${fmt(Math.round(totals.totalTokens * 0.3))} tokens.`,
        action: 'Enable CACHE_MODE in model-config.sh: identify 5-10 "hot" files (frequently modified files, config templates, test utilities) and pin them to context across iterations.',
      });
    }
  }

  // 5. Pipeline load peaks on specific days — tasks may be too large on heavy days
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
      const ratio = (busiest.avg / Math.max(quietest.avg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: 'day-pattern',
          lens: 'speed',
          type: 'neutral',
          title: `${busiest.day} pipeline runs average ${ratio}x more tokens than ${quietest.day} — tasks may be over-scoped on heavy days`,
          description: `${busiest.day} pipeline sessions average ${fmt(Math.round(busiest.avg))} tokens vs ${fmt(Math.round(quietest.avg))} on ${quietest.day}s. Heavier days likely have larger, more complex tasks that accumulate context faster across implement iterations.`,
          action: 'Add "Scope: under 3 files" constraint to task descriptions on high-volume days. Split large epics into focused sub-tasks before pipeline run.',
        });
      }
    }
  }

  // 6. Pipeline model config defaulted to Opus for short-session tasks
  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce((s, ses) => s + ses.totalTokens, 0);
      insights.push({
        id: 'model-mismatch',
        lens: 'cost',
        type: 'warning',
        title: `Pipeline model config routed ${simpleOpus.length} short-session tasks to Opus — Sonnet handles these equally`,
        description: `${simpleOpus.length} pipeline runs used Opus for tasks under 10 iterations and ${fmt(wastedTokens)} total tokens. Opus is 5x more expensive than Sonnet per token. Short implement tasks (single file edits, test fixes, config changes) don't need Opus's extra reasoning depth.`,
        action: 'Set DEFAULT_MODEL=sonnet in model-config.sh. Reserve Opus for tasks with 5+ file changes or COMPLEX label in task description.',
      });
    }
  }

  // 7. Explore stage searches too broadly — task descriptions lack file paths
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
        title: `Explore stage averaged ${Math.round(avgRatio)} file searches per task input across ${toolHeavy.length} sessions — task descriptions lack file paths`,
        description: `In ${toolHeavy.length} pipeline runs, the explore stage made ~${Math.round(avgRatio)} file search/read operations per task turn. Each search re-reads the full conversation context. These runs used ${fmt(totalToolTokens)} tokens total. Under-specified task descriptions force the explore stage to scan broadly instead of targeting known files.`,
        action: 'Add file paths to task descriptions in the explore skill template. Include "Affected files: src/module/file.js" field in task format so explore stage skips broad searches.',
      });
    }
  }

  // 8. One project's pipeline dominates token spend — apply optimizations there first
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
          title: `${pct}% of pipeline tokens come from one project (${projName}) — highest ROI for scope optimizations`,
          description: `The "${projName}" pipeline used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total (${pct}%). Applying task scope limits and file path targeting to this project's pipeline config will have the largest impact on total spend.`,
          action: 'Add "Scope: under 3 files" and "Affected files:" fields to task template in this project\'s CLAUDE.md. Split any multi-subsystem tasks into separate pipeline runs.',
        });
      }
    }
  }

  // 9. Implement stage tasks run too long — tasks exceed single-session scope
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
          title: `Implement stage averages ${ratio}x more tokens per turn in long-running tasks — split tasks to reset context`,
          description: `Focused pipeline runs (under 15 iterations) cost ~${fmt(shortAvg)} tokens per turn. Long runs (80+ iterations) cost ~${fmt(longAvg)} tokens per turn — ${ratio}x more — because each iteration re-reads the full accumulated context. Long implement sessions indicate tasks are over-scoped for a single pipeline run.`,
          action: 'Update task template in CLAUDE.md: require "Scope: under 3 files" and "Done when: [specific criteria]" fields. Split large refactors into file-focused sub-tasks with separate pipeline runs.',
        });
      }
    }
  }

  // 10. Pipeline startup context bloated by CLAUDE.md — overhead compounds per run
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
        title: `Pipeline startup loads ${fmt(avgStartTokens)}+ tokens of base context across ${heavyStarts.length} runs — CLAUDE.md overhead compounds per iteration`,
        description: `Each pipeline run starts by loading CLAUDE.md, project files, and system context before the first task. In ${heavyStarts.length} runs, this baseline averaged ${fmt(avgStartTokens)} tokens — ${fmt(totalOverhead)} tokens total just on startup context that gets re-read with every implement iteration.`,
        action: 'Trim CLAUDE.md to under 2KB: move verbose skill docs to linked files, remove unused instruction sections. Smaller startup context reduces cost of every iteration in every run.',
      });
    }
  }

  // 11. Pipeline model routing cost — Opus selected for short-session tasks
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
      insights.push({
        id: 'wasted-escalation-cost',
        lens: 'cost',
        type: 'warning',
        title: `Pipeline model routing spent $${totalWasted.toFixed(2)} extra — Opus selected for ${escalatedSessions.length} short-session tasks that fit Sonnet`,
        description: `${escalatedSessions.length} pipeline runs used Opus for lightweight tasks (under 20 iterations, under 500K tokens), costing ~$${totalWasted.toFixed(2)} more than Sonnet would have. These tasks — single-file edits, test fixes, config changes — don't require Opus's reasoning depth. Model routing config is not differentiating task complexity.`,
        action: 'Set DEFAULT_MODEL=sonnet in model-config.sh. Increase quality loop limit in model-config.sh for Sonnet to allow more iterations before escalating to Opus.',
      });
    }
  }

  // 12. Implement stage lacks explicit stopping criteria — task template missing "Done when" field
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
        title: `Implement stage took ${Math.round(avgRatio)}x more steps than prompted across ${scopeCreepSessions.length} runs — task template lacks explicit stopping criteria`,
        description: `In ${scopeCreepSessions.length} pipeline runs, the implement stage made ~${Math.round(avgRatio)} autonomous steps per prompted task turn. These ${scopeCreepSessions.length} runs used ${fmt(totalScopeTokens)} tokens total. Without a "Done when" field in task descriptions, the implement stage continues beyond the stated goal: refactoring adjacent files, adding unrequested features, or extending test coverage beyond scope.`,
        action: 'Add "Done when: [specific criteria]" field to task template in CLAUDE.md (e.g., "Done when: target file changed, tests pass, no other files modified"). Add file path constraints to explore skill to prevent out-of-scope reads.',
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

// Structured prompt patterns that identify pipeline-dispatched subagent sessions
const PIPELINE_PROMPT_PATTERNS = [
  /implement task \d+/i,
  /on branch wt-/i,
  /on branch feature\/issue-/i,
  /\*\*\([SML]\)\*\*/,
  /address (?:PR|code) review feedback/i,
  /fix test failures in working directory/i,
  /simplify modified (?:TypeScript|React)/i,
  /write JSDoc\/TSDoc comments/i,
  /validate test comprehensiveness/i,
  /address test quality issues/i,
  /ENVIRONMENT NOTE:/,
];

function categorizeSession(session) {
  const prompt = session.firstPrompt || '';
  const isStructured = PIPELINE_PROMPT_PATTERNS.some(re => re.test(prompt));
  return isStructured ? 'pipeline_subagent' : 'interactive';
}

function computePPMTAnalysis(runs, dailyUsage) {
  // 1. taskSizeCompletion — S/M/L completion rates with counts
  const taskSizeCompletion = {
    S: { completed: 0, failed: 0, total: 0, rate: 0 },
    M: { completed: 0, failed: 0, total: 0, rate: 0 },
    L: { completed: 0, failed: 0, total: 0, rate: 0 },
  };
  for (const run of runs) {
    const ts = run.taskSummary;
    if (!ts) continue;
    for (const size of ['S', 'M', 'L']) {
      taskSizeCompletion[size].completed += (ts.completed && ts.completed[size]) || 0;
      taskSizeCompletion[size].failed += (ts.failed && ts.failed[size]) || 0;
    }
  }
  for (const size of ['S', 'M', 'L']) {
    const s = taskSizeCompletion[size];
    s.total = s.completed + s.failed;
    s.rate = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
  }

  // 2. escalationCorrelation — completion rates by escalation count bucket
  const buckets = { '0': { completed: 0, total: 0 }, '1-2': { completed: 0, total: 0 }, '3-5': { completed: 0, total: 0 }, '6+': { completed: 0, total: 0 } };
  for (const run of runs) {
    const count = (run.escalations || []).length;
    const bucket = count === 0 ? '0' : count <= 2 ? '1-2' : count <= 5 ? '3-5' : '6+';
    buckets[bucket].total++;
    if (run.state === 'completed') buckets[bucket].completed++;
  }
  const escalationCorrelation = {};
  for (const [key, val] of Object.entries(buckets)) {
    escalationCorrelation[key] = {
      total: val.total,
      completed: val.completed,
      completionRate: val.total > 0 ? Math.round((val.completed / val.total) * 100) : 0,
    };
  }

  // 3. failureBreakdown — counts by failure type
  const failureBreakdown = { parse_failure: 0, aborted: 0, error: 0, max_iterations_pr_review: 0, running: 0, no_changes: 0, other: 0 };
  for (const run of runs) {
    if (run.state === 'error' && run.taskCount === 0) {
      // Distinguish aborted startup crashes from genuine parse failures
      if (run.parseIssueCompleted) {
        failureBreakdown.parse_failure++;
      } else {
        failureBreakdown.aborted++;
      }
    } else if (run.state === 'error') {
      failureBreakdown.error++;
    } else if (run.state === 'max_iterations_pr_review') {
      failureBreakdown.max_iterations_pr_review++;
    } else if (run.state === 'running') {
      failureBreakdown.running++;
    } else if (run.state === 'no_changes') {
      failureBreakdown.no_changes++;
    } else if (run.state !== 'completed') {
      failureBreakdown.other++;
    }
  }

  // 4. taskCountCorrelation — avg task count for completed vs failed with optimal range
  // Exclude taskCount === 0 (parse failures that never parsed tasks) — they skew failedAvg
  const completedRuns = runs.filter(r => r.state === 'completed' && r.taskCount > 0);
  const failedRuns = runs.filter(r => r.state !== 'completed' && r.state !== 'running' && r.taskCount > 0);
  const completedAvg = completedRuns.length > 0
    ? Math.round(completedRuns.reduce((s, r) => s + r.taskCount, 0) / completedRuns.length)
    : 0;
  const failedAvg = failedRuns.length > 0
    ? Math.round(failedRuns.reduce((s, r) => s + r.taskCount, 0) / failedRuns.length)
    : 0;

  // Find task count range with highest completion rate (bucket by count)
  // Exclude taskCount === 0 runs from bucket analysis
  const countBuckets = {};
  for (const run of runs) {
    // Exclude still-running and zero-task runs from optimal range calculation
    if (run.state === 'running' || run.taskCount === 0) continue;
    const bucket = Math.floor(run.taskCount / 2) * 2; // group by pairs: 0-1, 2-3, 4-5, ...
    if (!countBuckets[bucket]) countBuckets[bucket] = { completed: 0, total: 0 };
    countBuckets[bucket].total++;
    if (run.state === 'completed') countBuckets[bucket].completed++;
  }
  const bestBucket = Object.entries(countBuckets)
    .filter(([, v]) => v.total >= 5)
    .map(([k, v]) => ({ start: Number(k), rate: v.completed / v.total }))
    .sort((a, b) => b.rate - a.rate)[0];
  const optimalRange = bestBucket ? [bestBucket.start, bestBucket.start + 1] : [];

  const taskCountCorrelation = { completedAvg, failedAvg, optimalRange };

  // 5. topEscalationStages — top 5 stages by escalation count
  const stageCounts = {};
  for (const run of runs) {
    for (const esc of run.escalations || []) {
      if (esc.stage) stageCounts[esc.stage] = (stageCounts[esc.stage] || 0) + 1;
    }
  }
  const topEscalationStages = Object.entries(stageCounts)
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // 6. projectYield — per-project SP yield percentages
  const projectMap = {};
  for (const run of runs) {
    if (!run.project) continue;
    if (!projectMap[run.project]) projectMap[run.project] = { spCompleted: 0, spTotal: 0 };
    const ts = run.taskSummary;
    if (ts) {
      projectMap[run.project].spCompleted += ts.storyPointsCompleted || 0;
      projectMap[run.project].spTotal += ts.storyPointsTotal || 0;
    }
  }
  const projectYield = Object.entries(projectMap).map(([project, data]) => ({
    project,
    spCompleted: data.spCompleted,
    spTotal: data.spTotal,
    yieldPct: data.spTotal > 0 ? Math.round((data.spCompleted / data.spTotal) * 100) : 0,
  })).sort((a, b) => b.spTotal - a.spTotal);

  // 7. ppmtByDay — daily PP/MT values joining run SP with session tokens by date
  const dailySP = {};
  for (const run of runs) {
    if (!run.date || !run.taskSummary) continue;
    if (!dailySP[run.date]) dailySP[run.date] = 0;
    dailySP[run.date] += run.taskSummary.storyPointsCompleted || 0;
  }
  const dailyTokenMap = {};
  for (const day of dailyUsage) {
    dailyTokenMap[day.date] = day.totalTokens || 0;
  }
  const allDates = new Set([...Object.keys(dailySP), ...Object.keys(dailyTokenMap)]);
  const ppmtByDay = [...allDates].sort().map(date => {
    const sp = dailySP[date] || 0;
    const tokens = dailyTokenMap[date] || 0;
    // PP/100MT: story points per 100 million pipeline tokens
    const pp100mt = tokens > 0 ? Math.round((sp / (tokens / 100_000_000)) * 100) / 100 : 0;
    return { date, spCompleted: sp, totalTokens: tokens, pp100mt };
  });

  // Compute overall PP/100MT from totals
  const totalSP = ppmtByDay.reduce((s, d) => s + d.spCompleted, 0);
  const totalTokens = ppmtByDay.reduce((s, d) => s + d.totalTokens, 0);
  const pp100mt = totalTokens > 0 ? Math.round((totalSP / (totalTokens / 100_000_000)) * 100) / 100 : 0;

  return { taskSizeCompletion, escalationCorrelation, failureBreakdown, taskCountCorrelation, topEscalationStages, projectYield, ppmtByDay, pp100mt };
}

function generatePPMTRecommendations(analysis) {
  const { taskSizeCompletion, escalationCorrelation, failureBreakdown, taskCountCorrelation, topEscalationStages, projectYield } = analysis;

  // Derive total run count from escalationCorrelation buckets
  const totalRuns = Object.values(escalationCorrelation).reduce((s, b) => s + b.total, 0);
  if (totalRuns < 5) return [];

  const recs = [];

  // (a) M-task splitting: M completion% < S completion% by >15 points
  if (taskSizeCompletion.M.total >= 5 && taskSizeCompletion.S.total >= 5) {
    const gap = taskSizeCompletion.S.rate - taskSizeCompletion.M.rate;
    if (gap > 15) {
      recs.push({
        id: 'm_task_splitting',
        priority: gap > 30 ? 1 : 2,
        ppmt_impact: Math.min(Math.round(gap * 0.5), 100),
        title: 'Split M-tasks into smaller S-tasks',
        detail: `M tasks complete at ${taskSizeCompletion.M.rate}% vs S tasks at ${taskSizeCompletion.S.rate}% (${gap} point gap across ${taskSizeCompletion.M.total} M-tasks)`,
        evidence: { M: taskSizeCompletion.M, S: taskSizeCompletion.S },
        action: 'Review backlog M-tasks and break each into 2–3 S-tasks to improve completion rate',
      });
    }
  }

  // (b) Parse failures: >2 exist
  if (failureBreakdown.parse_failure > 2) {
    const count = failureBreakdown.parse_failure;
    recs.push({
      id: 'parse_failures',
      priority: count > 5 ? 1 : 2,
      ppmt_impact: Math.min(count * 3, 100),
      title: `Fix parse failures affecting ${count} runs`,
      detail: `${count} parse failures detected (runs with 0 tasks parsed) — each represents a total loss of output`,
      evidence: { parse_failure: count },
      action: `Audit ${count} runs with parse failures; check orchestrator log format for breaking changes or schema drift`,
    });
  }

  // (c) Task count reduction: avg failed task count > avg completed by >1.5
  if (taskCountCorrelation.failedAvg > taskCountCorrelation.completedAvg + 1.5) {
    const diff = Math.round((taskCountCorrelation.failedAvg - taskCountCorrelation.completedAvg) * 10) / 10;
    recs.push({
      id: 'task_count_reduction',
      priority: diff > 3 ? 1 : 2,
      ppmt_impact: Math.min(Math.round(diff * 5), 100),
      title: 'Reduce task count per run',
      detail: `Failed runs average ${taskCountCorrelation.failedAvg} tasks vs ${taskCountCorrelation.completedAvg} for completed runs (${diff} task difference)`,
      evidence: { taskCountCorrelation },
      action: `Target ≤${taskCountCorrelation.completedAvg} tasks per run to match successful run profile${taskCountCorrelation.optimalRange.length ? `; optimal range is ${taskCountCorrelation.optimalRange[0]}–${taskCountCorrelation.optimalRange[1]}` : ''}`,
    });
  }

  // (d) PR review loop: >2 max_iterations_pr_review runs
  if (failureBreakdown.max_iterations_pr_review > 2) {
    const count = failureBreakdown.max_iterations_pr_review;
    recs.push({
      id: 'pr_review_loop',
      priority: count > 5 ? 1 : 3,
      ppmt_impact: Math.min(count * 4, 100),
      title: `Address PR review loops (${count} runs hit max iterations)`,
      detail: `${count} runs terminated by hitting max PR review iterations — work was completed but PRs stalled`,
      evidence: { max_iterations_pr_review: count },
      action: 'Clarify PR acceptance criteria; consider smaller, more focused PRs to reduce back-and-forth review cycles',
    });
  }

  // (e) max_turns_exhausted: top escalation stage has >10 escalations
  if (topEscalationStages.length > 0 && topEscalationStages[0].count > 10) {
    const top = topEscalationStages[0];
    recs.push({
      id: 'max_turns_exhausted',
      priority: top.count > 20 ? 1 : 2,
      ppmt_impact: Math.min(Math.round(top.count * 2), 100),
      title: `Reorder or split stage '${top.stage}'`,
      detail: `Stage '${top.stage}' has ${top.count} escalations — the highest of any stage, indicating repeated turn exhaustion`,
      evidence: { topStage: top },
      action: `Reorder '${top.stage}' earlier in the pipeline or split it into smaller sub-stages to reduce escalation frequency`,
    });
  }

  // (f) Project-specific yield: any project's yield <20%
  for (const proj of projectYield) {
    if (proj.yieldPct < 20) {
      recs.push({
        id: `project_yield_${proj.project}`,
        priority: proj.yieldPct < 10 ? 1 : 3,
        ppmt_impact: Math.min(Math.round((20 - proj.yieldPct) * 0.5 * proj.spTotal), 100),
        title: `Low yield for project '${proj.project}'`,
        detail: `Project '${proj.project}' yields only ${proj.yieldPct}% (${proj.spCompleted}/${proj.spTotal} SP completed)`,
        evidence: proj,
        action: `Investigate common failure modes in project '${proj.project}'; consider task sizing review or scoping adjustments`,
      });
    }
  }

  // (g) 0-escalation failure pattern: >30% of failures have 0 escalations
  const zeroEscFail = escalationCorrelation['0'].total - escalationCorrelation['0'].completed;
  const totalFailures = Object.values(escalationCorrelation).reduce((s, b) => s + (b.total - b.completed), 0);
  if (totalFailures > 0 && zeroEscFail / totalFailures > 0.30) {
    const pct = Math.round((zeroEscFail / totalFailures) * 100);
    recs.push({
      id: 'zero_escalation_failures',
      priority: pct > 60 ? 1 : 3,
      ppmt_impact: Math.min(zeroEscFail * 2, 100),
      title: `${pct}% of failures occur with 0 escalations`,
      detail: `${zeroEscFail} of ${totalFailures} failed runs (${pct}%) had 0 escalations — tasks failing silently without requesting help`,
      evidence: { zeroEscalationFailures: zeroEscFail, totalFailures, zeroEscalationCorrelation: escalationCorrelation['0'] },
      action: 'Review 0-escalation failures for early task setup errors or misunderstood requirements; add pre-task validation checks',
    });
  }

  // Sort by priority ascending (1 = highest)
  recs.sort((a, b) => a.priority - b.priority);

  return recs;
}

function computeSessionEfficiency(sessions) {
  const pipeline = { sessions: 0, tokens: 0, queries: 0 };
  const interactive = { sessions: 0, tokens: 0, queries: 0 };

  for (const s of sessions) {
    const type = s.sessionType || categorizeSession(s);
    if (type === 'pipeline_subagent') {
      pipeline.sessions++;
      pipeline.tokens += s.totalTokens || 0;
      pipeline.queries += s.queryCount || 0;
    } else {
      interactive.sessions++;
      interactive.tokens += s.totalTokens || 0;
      interactive.queries += s.queryCount || 0;
    }
  }

  const totalTokens = pipeline.tokens + interactive.tokens;
  const pipelinePct = totalTokens > 0 ? Math.round((pipeline.tokens / totalTokens) * 100) : 0;
  const interactivePct = totalTokens > 0 ? 100 - pipelinePct : 0;

  // Marathon sessions: 100+ queries
  const marathonSessions = sessions
    .filter(s => (s.queryCount || 0) >= 100)
    .map(s => ({
      date: s.date,
      firstPrompt: s.firstPrompt,
      totalTokens: s.totalTokens || 0,
      queryCount: s.queryCount || 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // Implementation-like prompts outside pipeline
  const implPattern = /^(fix|add|update|create|build|refactor)\b/i;
  const implSessions = sessions.filter(s => {
    const type = s.sessionType || categorizeSession(s);
    return type === 'interactive' && s.firstPrompt && implPattern.test(s.firstPrompt);
  });
  const implementationOutsidePipeline = {
    count: implSessions.length,
    totalTokens: implSessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0),
  };

  // Context balloon curve
  const bucketDefs = [
    { bucket: '1-10', min: 1, max: 10 },
    { bucket: '11-50', min: 11, max: 50 },
    { bucket: '51-100', min: 51, max: 100 },
    { bucket: '100+', min: 101, max: Infinity },
  ];
  const bucketTotals = bucketDefs.map(() => ({ totalTokens: 0, count: 0 }));

  for (const s of sessions) {
    const queries = s.queries || [];
    for (let i = 0; i < queries.length; i++) {
      const position = i + 1; // 1-indexed
      const qTokens = queries[i].totalTokens || 0;
      for (let b = 0; b < bucketDefs.length; b++) {
        if (position >= bucketDefs[b].min && position <= bucketDefs[b].max) {
          bucketTotals[b].totalTokens += qTokens;
          bucketTotals[b].count++;
          break;
        }
      }
    }
  }

  const contextBalloonCurve = bucketDefs.map((def, i) => ({
    bucket: def.bucket,
    avgTokensPerQuery: bucketTotals[i].count > 0
      ? Math.round(bucketTotals[i].totalTokens / bucketTotals[i].count)
      : 0,
  }));

  // Model efficiency analysis for interactive sessions
  const interactiveSessions = sessions.filter(s => (s.sessionType || categorizeSession(s)) !== 'pipeline_subagent');
  const modelStats = {};
  for (const s of interactiveSessions) {
    const m = (s.model || '').includes('opus') ? 'opus' : (s.model || '').includes('sonnet') ? 'sonnet' : (s.model || '').includes('haiku') ? 'haiku' : 'other';
    if (!modelStats[m]) modelStats[m] = { sessions: 0, tokens: 0, queries: 0 };
    modelStats[m].sessions++;
    modelStats[m].tokens += s.totalTokens || 0;
    modelStats[m].queries += s.queryCount || 0;
  }
  for (const m of Object.keys(modelStats)) {
    modelStats[m].avgTokensPerQuery = modelStats[m].queries > 0 ? Math.round(modelStats[m].tokens / modelStats[m].queries) : 0;
    modelStats[m].avgTokensPerSession = modelStats[m].sessions > 0 ? Math.round(modelStats[m].tokens / modelStats[m].sessions) : 0;
    modelStats[m].avgQueriesPerSession = modelStats[m].sessions > 0 ? Math.round(modelStats[m].queries / modelStats[m].sessions) : 0;
  }

  // Session length distribution for interactive sessions
  const lengthBuckets = { short: { label: '1-20', min: 1, max: 20, count: 0, tokens: 0 }, medium: { label: '21-50', min: 21, max: 50, count: 0, tokens: 0 }, long: { label: '50+', min: 51, max: Infinity, count: 0, tokens: 0 } };
  for (const s of interactiveSessions) {
    const qc = s.queryCount || 0;
    if (qc <= 20) { lengthBuckets.short.count++; lengthBuckets.short.tokens += s.totalTokens || 0; }
    else if (qc <= 50) { lengthBuckets.medium.count++; lengthBuckets.medium.tokens += s.totalTokens || 0; }
    else { lengthBuckets.long.count++; lengthBuckets.long.tokens += s.totalTokens || 0; }
  }

  // Efficiency by day — daily aggregation of interactive session metrics
  const _modelBucket = m => (m || '').includes('opus') ? 'opus' : (m || '').includes('sonnet') ? 'sonnet' : (m || '').includes('haiku') ? 'haiku' : 'other';
  const _emptyModelMap = () => ({ haiku: 0, sonnet: 0, opus: 0, other: 0 });
  const _initDay = () => ({ queries: 0, tokens: 0, pipelineTokens: 0, sessions: 0, shortSessions: 0, pipelineByModel: _emptyModelMap(), interactiveByModel: _emptyModelMap() });
  const dayMap = {};
  for (const s of sessions) {
    const type = s.sessionType || categorizeSession(s);
    if (type === 'pipeline_subagent') continue;
    const d = s.date;
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = _initDay();
    dayMap[d].sessions++;
    dayMap[d].queries += s.queryCount || 0;
    dayMap[d].tokens += s.totalTokens || 0;
    if ((s.queryCount || 0) <= 20) dayMap[d].shortSessions++;
    dayMap[d].interactiveByModel[_modelBucket(s.model)] += s.totalTokens || 0;
  }
  // Add pipeline tokens per day (create entry if needed for pipeline-only days)
  for (const s of sessions) {
    const type = s.sessionType || categorizeSession(s);
    if (type !== 'pipeline_subagent') continue;
    const d = s.date;
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = _initDay();
    dayMap[d].pipelineTokens += s.totalTokens || 0;
    dayMap[d].pipelineByModel[_modelBucket(s.model)] += s.totalTokens || 0;
  }
  const efficiencyByDay = Object.keys(dayMap).sort().map(date => {
    const dm = dayMap[date];
    const totalTokens = dm.pipelineTokens + dm.tokens;
    return {
      date,
      avgQueriesPerSession: dm.sessions > 0 ? Math.round(dm.queries / dm.sessions) : 0,
      tokensPerQuery: dm.queries > 0 ? Math.round(dm.tokens / dm.queries) : 0,
      pipelineCoveragePct: totalTokens > 0 ? Math.round(dm.pipelineTokens / totalTokens * 100) : 0,
      shortSessionPct: dm.sessions > 0 ? Math.round(dm.shortSessions / dm.sessions * 100) : 0,
      sessionCount: dm.sessions,
      pipelineTokens: dm.pipelineTokens,
      totalTokens,
      modelTokensByDay: { pipeline: { ...dm.pipelineByModel }, interactive: { ...dm.interactiveByModel } },
    };
  });

  return {
    pipeline,
    interactive,
    pipelinePct,
    interactivePct,
    marathonSessions,
    implementationOutsidePipeline,
    contextBalloonCurve,
    modelStats,
    lengthBuckets,
    efficiencyByDay,
  };
}

function generateSessionRecommendations(efficiency) {
  const recs = [];
  const ms = efficiency.modelStats || {};
  const lb = efficiency.lengthBuckets || {};

  // (a) Session length is the #1 cost driver — quantify it
  if (lb.long && lb.short && lb.long.count > 0 && lb.short.count > 0) {
    const longAvg = Math.round(lb.long.tokens / lb.long.count);
    const shortAvg = Math.round(lb.short.tokens / lb.short.count);
    const ratio = shortAvg > 0 ? Math.round(longAvg / shortAvg) : 0;
    const longPct = efficiency.interactive.tokens > 0 ? Math.round((lb.long.tokens / efficiency.interactive.tokens) * 100) : 0;
    if (ratio > 3 && longPct > 50) {
      recs.push({
        id: 'session_length',
        title: `50+ query sessions consume ${longPct}% of interactive tokens`,
        detail: `${lb.long.count} long sessions (50+ queries) average ${(longAvg / 1e6).toFixed(1)}M tokens each — ${ratio}x more than short sessions (1-20 queries) at ${(shortAvg / 1e6).toFixed(1)}M each. Use /clear mid-session to reset context when switching subtasks.`,
        action: 'Target under 50 queries per session. Start fresh or /clear when context drifts from your current goal.',
      });
    }
  }

  // (b) Model cost comparison — Opus vs Sonnet tokens-per-query
  if (ms.opus && ms.sonnet && ms.opus.sessions >= 5 && ms.sonnet.sessions >= 5) {
    const ratio = ms.sonnet.avgTokensPerQuery > 0 ? (ms.opus.avgTokensPerQuery / ms.sonnet.avgTokensPerQuery).toFixed(1) : 0;
    if (ratio > 1.5) {
      const opusFmt = (ms.opus.avgTokensPerQuery / 1000).toFixed(0) + 'K';
      const sonnetFmt = (ms.sonnet.avgTokensPerQuery / 1000).toFixed(0) + 'K';
      recs.push({
        id: 'model_cost',
        title: `Opus costs ${ratio}x more per query than Sonnet`,
        detail: `Opus averages ${opusFmt} tokens/query across ${ms.opus.sessions} sessions vs Sonnet at ${sonnetFmt} across ${ms.sonnet.sessions} sessions. Opus sessions also run ${ms.opus.avgQueriesPerSession}x longer on average (${ms.opus.avgQueriesPerSession} vs ${ms.sonnet.avgQueriesPerSession} queries).`,
        action: 'Use Sonnet for exploration, debugging, and iterative work. Reserve Opus for complex reasoning tasks that need it.',
      });
    }
  }

  // (c) Context balloon — quantify the exponential growth
  const curve = efficiency.contextBalloonCurve;
  const avg1to10 = curve.find(c => c.bucket === '1-10');
  const avg100plus = curve.find(c => c.bucket === '100+');
  if (avg1to10 && avg100plus && avg1to10.avgTokensPerQuery > 0 &&
      avg100plus.avgTokensPerQuery > avg1to10.avgTokensPerQuery * 2) {
    const ratio = Math.round(avg100plus.avgTokensPerQuery / avg1to10.avgTokensPerQuery);
    const earlyFmt = (avg1to10.avgTokensPerQuery / 1000).toFixed(0) + 'K';
    const lateFmt = (avg100plus.avgTokensPerQuery / 1000).toFixed(0) + 'K';
    recs.push({
      id: 'context_balloon',
      title: `Queries at position 100+ cost ${ratio}x more than early queries`,
      detail: `First 10 queries average ${earlyFmt} tokens each. After query 100, that jumps to ${lateFmt} — Claude re-reads the entire conversation every turn. The same question at query 100 costs ${ratio}x what it would in a fresh session.`,
      action: 'The cheapest fix: ask the same question in a new session instead of a long one.',
    });
  }

  // (d) Marathon sessions with specific examples
  const extremeMarathons = efficiency.marathonSessions.filter(s => s.queryCount > 200);
  if (extremeMarathons.length > 0) {
    const topExample = extremeMarathons[0];
    const tokensFmt = (topExample.totalTokens / 1e6).toFixed(0);
    recs.push({
      id: 'marathon_sessions',
      title: `${extremeMarathons.length} session(s) exceed 200 queries (${tokensFmt}M+ tokens each)`,
      detail: `Your most expensive session: "${(topExample.firstPrompt || '').slice(0, 80)}" on ${topExample.date} — ${topExample.queryCount} queries, ${(topExample.totalTokens / 1e6).toFixed(1)}M tokens. After ~50 queries, most of the tokens are context re-reading, not new work.`,
      action: 'Split into multiple focused sessions. Each new session starts with minimal context overhead.',
    });
  }

  return recs;
}

module.exports = { parseAllSessions, parseTaskSummary, computePPMTAnalysis, generatePPMTRecommendations, categorizeSession, computeSessionEfficiency, generateSessionRecommendations };

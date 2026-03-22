# Epic: Radical Dashboard Simplification — PP/100MT as North Star

This epic restructures the claude-spend dashboard around a single metric: **Points per 100M Tokens (PP/100MT)** — how many completed story points the pipeline delivers per 100 million tokens consumed.

## Key Design Decision: Pipeline-Only Denominator
PP/100MT uses **pipeline tokens only** as the denominator, not total tokens. 74% of tokens (8.1B) are spent in interactive CC sessions outside the pipeline — including this denominator would dilute the metric with untracked usage. Non-pipeline token efficiency is addressed separately in #31.

## Child Issues
- **#30 (this)** — Dashboard restructure: PP/100MT hero, remove vanity charts, add driver charts
- **#31** — Non-pipeline session analysis and efficiency recommendations

---

## Context
The dashboard has 18+ charts, 17+ insights, and 4 stat cards that overwhelm without guiding action. Most metrics (tokens/day, model mix, cache rate, output ratio) are vanity metrics disconnected from what matters: how much completed work you get per token spent. The dashboard needs radical simplification around PP/100MT with only the charts and data that explain or improve it.

## Research Findings

**PP/100MT driver analysis (from actual correlation data across 126 runs):**

| Driver | Evidence | Visualization |
|--------|----------|---------------|
| **Yield %** (SP completed / SP total) | Strongest predictor: 82% on best day, 0% on worst | Trend line over time |
| **Task size completion** (S vs M vs L) | S: 42% complete, M: 16%, L: 33% — M tasks are 2.6x worse | Grouped bar chart |
| **Failure type breakdown** | 11 parse fails (100% waste), 9 PR review loops, 19 stuck runs | Horizontal bar chart |
| **Task count vs outcome** | Completed avg 2.4 tasks, failed avg 4.3 | Comparison stat |

**Token accounting (Claude Code CLI only — not Desktop or web):**
- Pipeline subagent sessions: 2,473 sessions, 2.9B tokens (26%) — PP/100MT denominator
- Interactive CC sessions: 576 sessions, 8.1B tokens (74%) — analyzed separately in #31

**What stays (reordered):**
- PP/100MT hero chart → rescaled to per-100M, pipeline tokens only
- Efficiency recommendations → directly actionable
- 4 driver charts: yield %, task size completion, failure breakdown, task count vs outcome
- Project breakdown → with PP/100MT per project added
- Most expensive prompts → kept as-is

**What goes (18 items removed):**
- Stat cards row, 3-lens tab navigation
- All cost/speed vanity charts (tokens/day, by model, tier mix, cache, runs/day, error rate, tokens/query, read-write ratio, output ratio, context overhead)
- Stage performance, stage time-series (3 charts), velocity chart
- Run outcomes pie, churners table
- All old insights section (17 insight cards)

**Rescaling:** PP/MT (0.085) → PP/100MT (8.5). Denominator = pipeline tokens only.

### Files affected
- \`src/public/index.html\` — major restructure, remove sections, add 4 driver charts
- \`src/parser.js\` — rescale to PP/100MT, compute driver data, pipeline-only token denominator

## Evaluation
**Approach:** Gut the HTML, replace with PP/100MT-focused layout where each remaining visualization directly explains a driver of the north-star metric. Pipeline-only denominator.
**Rationale:** Every element must answer "how does this help the user get more completed work per token?" The 4 driver charts are chosen from actual correlation analysis. Non-pipeline tokens are a separate concern (#31).

**Risks:**
- Removing too much — mitigate by keeping raw data in API
- PP/100MT = 0 for users without orchestrator data — mitigate by showing setup guidance
- Pipeline-only denominator requires session categorization — mitigate by using conservative heuristic in parser

## Implementation Tasks
- [ ] \`[default]\` **(S)** In \`src/parser.js\`, add pipeline token isolation: categorize sessions as \`pipeline_subagent\` (query count <= 50 AND structured prompt patterns) vs \`interactive\`. Compute \`pipelineTokens\` total. Rescale all PP/MT to PP/100MT using pipeline-only tokens: update \`computePPMTAnalysis()\` to divide SP by pipeline tokens * 100, update \`ppmtByDay\` to use daily pipeline tokens (join with session categorization by date), update \`recommendations[].ppmt_impact\` to PP/100MT units. Add \`pp100mt\` field to each \`projectBreakdown\` entry. Add \`yieldByDay: [{date, yieldPct, spCompleted, spTotal}]\` to orchestrator summary.
- [ ] \`[default]\` **(M)** In \`src/public/index.html\`, delete all removed sections and their render functions. Remove: \`#statsRow\` and \`renderStats()\`, 3-lens tab navigation and all lens section containers, all removed chart canvases and render functions (dailyChart, modelChart, tierMixChart, cacheHitChart, costRunsChart, costErrorRateChart, tpqChart, ratioChart, outputRatioChart, contextOverheadChart, velocityChart, stageChart0-2), Pipeline Stage Performance, Run Outcomes, Churners, the insights section (\`clientGenerateInsights\`, \`clientGenerateOrchestratorInsights\`, \`renderInsights\`), \`renderCostSection\`, \`renderSpeedSection\`, \`renderQualitySection\` and their containers. Keep: \`renderSPPerTokenChart\` (rescaled), \`renderPPMTRecommendations\`, \`renderProjectBreakdown\`, \`renderTopPrompts\`.
- [ ] \`[default]\` **(M)** In \`src/public/index.html\`, build the new simplified layout: (1) Hero — single large PP/100MT number (latest from ppmtAnalysis, pipeline-only denominator), trend arrow (last 3 days vs prior 3 days), subtitle "Points per 100M Pipeline Tokens". (2) PP/100MT line chart — rescale existing \`renderSPPerTokenChart\` to * 100 with pipeline-only tokens, relabel axis. (3) Efficiency recommendations — move existing \`renderPPMTRecommendations()\`. (4) "What drives your score" header with 4 new charts: (a) Yield % trend — daily \`yieldByDay[].yieldPct\` as green line, explainer: "What percentage of attempted story points actually complete. The single strongest predictor of PP/100MT." (b) Task Size Completion — grouped bar: S/M/L completed vs total, explainer: "S tasks complete 2.6x more often than M tasks. Splitting M→S is the highest-leverage change." (c) Failure Breakdown — horizontal bars: parse failures, PR review loops, stuck running, other errors, explainer: "Where your tokens go to die. Parse failures are 100% waste — zero points, full token cost." (d) Task Count vs Outcome — comparison showing completed avg (2.4) vs failed avg (4.3), explainer: "Issues with 5+ tasks fail ~70% of the time. Keep issues to 2-3 tasks." (5) Project breakdown with PP/100MT column. (6) Most expensive prompts.
- [ ] \`[default]\` **(S)** Add explainer text below each section in \`src/public/index.html\`. Each is a single muted sentence connecting the chart to PP/100MT. Also add footer: "PP/100MT measures completed story points per 100M pipeline tokens. Charts above explain factors that move this number. Recommendations tell you what to change. Non-pipeline session analysis is in the Session Efficiency section."
- [ ] \`[default]\` **(S)** Update Playwright tests in \`tests/dashboard-cards.spec.js\`: remove all tests for deleted elements (stat cards, lens tabs, model charts, insights). Add tests: PP/100MT hero number renders, PP/100MT chart canvas exists, recommendations section has cards, 4 driver charts exist (yield, task-size, failure, task-count), project breakdown has PP/100MT column, top prompts renders.

## Acceptance Criteria
- [ ] AC1: PP/100MT hero number is the first visible element — no stat cards, no lens tabs above it
- [ ] AC2: All removed charts/sections (18 items) deleted from HTML and JS
- [ ] AC3: PP/100MT uses pipeline-only tokens as denominator (not total tokens including interactive sessions)
- [ ] AC4: 4 driver charts render: yield % trend, task size completion, failure breakdown, task count vs outcome
- [ ] AC5: Each driver chart has a 1-sentence explainer connecting it to PP/100MT
- [ ] AC6: Project breakdown includes PP/100MT per project
- [ ] AC7: Playwright tests pass with simplified structure

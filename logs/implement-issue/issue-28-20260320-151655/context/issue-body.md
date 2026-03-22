## Context
Points per Million Tokens (PP/MT) is the single north-star metric for pipeline efficiency. The current recommendation system uses 4 independent lenses (model, context, conversation, pipeline) that optimize for cost reduction — but cheaper runs that fail produce 0 SP and actively hurt PP/MT. The server needs to analyze correlations in the run data and generate specific, data-backed recommendations to improve PP/MT.

## Research Findings

### Correlation Analysis (126 runs, 63 completed, 63 failed)

**Task size vs completion:**
- S tasks: 88/208 completed (42%)
- M tasks: 9/55 completed (16%) — **2.6x worse than S**
- L tasks: 4/12 completed (33%)

**Escalation count vs outcome (counterintuitive):**
- 0 escalations: 57 runs, **18% complete** — these die before any work starts
- 1-2 escalations: 46 runs, **76% complete** — escalation = progress
- 3+ escalations: 23 runs, **78% complete**

**Failure breakdown:**
- 35 error-state runs (11 were parse failures with 0 tasks = total waste)
- 19 stuck in "running" state (abandoned)
- 9 max_iterations_pr_review (tasks completed but PR review loops forever)

**Top escalation stages:** test (33), implement-task-1 (20), fix-pr-review (18), docs (14), pr (12)

**Task count vs outcome:**
- Completed runs average 2.4 tasks
- Failed runs average 4.3 tasks
- Issues with 5+ tasks have ~70% failure rate

**Project-level yield:** beegee-farm-3: 22%, claude-spend: 29%, claude-pipeline: 23%, Hubspot: 15%

**Day-of-week:** Thu/Wed PP/MT is 3-5x higher than Mon/Sun

**max_turns_exhausted:** 150/172 escalations (87%) — agents run out of turns before completing

### Files affected
- \`src/parser.js\` — add server-side PP/MT analysis engine computing correlations and generating recommendations from run data
- \`src/public/index.html\` — replace 4-lens recommendation UI with single PP/MT-focused section rendering server-computed recommendations

**Current behavior:** 4-lens client-side recommendations optimizing for cost.
**Desired behavior:** Server-side analysis engine that correlates run characteristics with PP/MT outcomes and generates ranked, specific, data-backed recommendations with evidence.

## Evaluation
**Approach:** Server-side analysis in the parser computes correlations and generates structured recommendations. Dashboard just renders them.

**Rationale:** The parser has access to all run data and can compute correlations across the full history. Client-side analysis is limited to what's loaded. Server-side also means the analysis logic is testable and the recommendations are available via the API for other consumers.

**Risks:**
- Insufficient data for some patterns — mitigate by requiring minimum sample sizes before generating a recommendation
- Recommendations becoming stale as patterns change — mitigate by computing fresh on each API call

## Implementation Tasks
- [ ] \`[default]\` **(M)** In \`src/parser.js\`, add a \`computePPMTAnalysis(runs, dailyUsage)\` function that computes: (1) \`taskSizeCompletion\` — S/M/L completion rates with counts, (2) \`escalationCorrelation\` — completion rates by escalation count bucket (0, 1-2, 3-5, 6+), (3) \`failureBreakdown\` — counts by failure type (parse_failure where taskCount=0, error, max_iterations_pr_review, stuck_running), (4) \`taskCountCorrelation\` — avg task count for completed vs failed runs with optimal range, (5) \`topEscalationStages\` — top 5 stages by escalation count, (6) \`projectYield\` — per-project SP yield percentages, (7) \`ppmtByDay\` — daily PP/MT values joining run SP with session tokens by date. Wire this into the orchestrator summary returned by the API.
- [ ] \`[default]\` **(M)** In \`src/parser.js\`, add a \`generatePPMTRecommendations(analysis)\` function that takes the output of \`computePPMTAnalysis\` and produces a ranked \`recommendations[]\` array. Each recommendation has: \`id\`, \`priority\` (1=highest), \`ppmt_impact\` (estimated improvement), \`title\`, \`detail\` (with specific numbers from the data), \`evidence\` (raw data backing the claim), \`action\` (specific step to take). Generate recommendations for: (a) M-task splitting if M completion% < S completion% by >15 points, (b) parse failures if >2 exist (cite specific issue numbers), (c) task count reduction if avg failed task count > avg completed by >1.5, (d) PR review loop if >2 max_iterations_pr_review runs exist, (e) max_turns_exhausted if top stage has >10 escalations (cite stage name and suggest reorder/split), (f) project-specific yield if any project's yield is <20%, (g) 0-escalation failure pattern if >30% of failures have 0 escalations. Only generate a rec if minimum sample size (5 runs) is met.
- [ ] \`[default]\` **(S)** In \`src/public/index.html\`, replace \`clientGenerateRecommendations()\` (~line 1157-1340) with a \`renderPPMTRecommendations()\` function that reads \`FILTERED.orchestrator.summary.recommendations\` from the API response and renders them. Remove the 4 lens categories (model/context/conversation/pipeline). Render a single "Efficiency" section with recommendations sorted by priority. Each card shows: title, detail text, evidence stats, action text, and PP/MT impact badge.
- [ ] \`[default]\` **(S)** Update \`lensStats\` in \`src/public/index.html\` (~line 1900-1910): replace cost/speed/quality stat pills with PP/MT-focused pills reading from \`FILTERED.orchestrator.summary.ppmtAnalysis\`: current PP/MT (from ppmtByDay latest), trend arrow (comparing recent 3 days vs prior 3 days), yield % (total SP completed / total SP attempted), and top waste category (largest failure type from failureBreakdown).

## Acceptance Criteria
- [ ] AC1: Server-side \`computePPMTAnalysis()\` computes all 7 correlation dimensions from run data
- [ ] AC2: \`generatePPMTRecommendations()\` produces recommendations with specific numbers from the data (e.g., "M tasks complete 16% vs S at 42%") not hardcoded strings
- [ ] AC3: Each recommendation includes \`evidence\` (raw data), \`action\` (specific step), and \`ppmt_impact\` (estimated improvement)
- [ ] AC4: Recommendations only appear when minimum sample sizes are met (5+ runs)
- [ ] AC5: Dashboard renders server-computed recommendations — no analysis logic in the client
- [ ] AC6: Stat pills show PP/MT, yield %, trend, and top waste category

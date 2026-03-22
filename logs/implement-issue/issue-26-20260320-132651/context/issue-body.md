## Context
The orchestrator tracks individual task completions with S/M/L sizing labels in status.json. By mapping S/M/L to Fibonacci story points (S=1, M=3, L=5), we can show a velocity run rate — story points completed per day — giving a meaningful throughput metric that weights task complexity.

## Research Findings

**Data available in status.json per run:**
- \`tasks[]\` array with \`status\` (completed/failed/pending/in_progress) and \`description\` containing \`**(S)**\`, \`**(M)**\`, or \`**(L)**\` labels
- Upstream (claude-pipeline) will add a pre-computed \`task_summary\` field, but parser should also handle raw extraction as fallback

**Parser gap (\`src/parser.js\` ~line 549-567):**
- Currently only captures \`taskCount: (raw.tasks || []).length\` — discards individual task sizes and completion statuses
- Needs to extract per-task size labels and statuses, compute story points per run

**Dashboard gap (\`src/public/index.html\`):**
- Has existing chart infrastructure (canvas-based, responsive, tooltips)
- Pipeline section already has mini time-series charts for runs/day, error rate, etc.
- No velocity or story point concept exists yet

**Files affected:**
- \`src/parser.js\` (~line 549) — extract task sizes/statuses, compute story points per run
- \`src/public/index.html\` — add velocity chart, story point stats card

**Current behavior:** Dashboard shows pipeline completion rate as a single percentage. No visibility into complexity-weighted throughput.
**Desired behavior:** A dual-axis line chart showing daily story points completed (left axis) and cumulative story points (right axis), with stats showing velocity metrics.

## Evaluation
**Approach:** Fibonacci mapping S=1, M=3, L=5 extracted at parse time, rendered as a line chart in the pipeline section.
**Rationale:** Extracting at parse time keeps dashboard rendering simple. Using existing canvas chart infrastructure avoids new dependencies. Prefer pre-computed \`task_summary\` from upstream but fall back to regex parsing for backwards compatibility.

**Risks:**
- Tasks without size labels — mitigate by defaulting to S=1
- Low run count may produce noisy velocity — mitigate by showing weekly rolling average

## Implementation Tasks
- [ ] \`[default]\` **(S)** In \`src/parser.js\` (~line 549-567), extend the \`runs.push({...})\` object to include \`taskSummary: { completed: {S: n, M: n, L: n}, failed: {S: n, M: n, L: n}, total: n, storyPointsCompleted: n, storyPointsTotal: n }\`. Use \`raw.task_summary\` if present (upstream), otherwise parse each task description for \`**(S)**\`/\`**(M)**\`/\`**(L)**\` regex. Map to Fibonacci points (S=1, M=3, L=5), default unknown to S=1.
- [ ] \`[default]\` **(S)** In \`src/parser.js\`, extend the orchestrator \`summary\` object (~line 647) to include \`velocityByDay: [{date, spCompleted, spTotal, cumulative}]\` and \`velocityStats: {totalSP, completedSP, avgSPPerDay, avgSPPerWeek}\`.
- [ ] \`[default]\` **(M)** In \`src/public/index.html\`, add a "Story Point Velocity" chart card in the pipeline quality section. Render a dual-axis line chart: left axis = daily SP completed (green), right axis = cumulative SP (purple). Use the existing canvas rendering pattern from \`renderContextOverheadChart()\` as template.
- [ ] \`[default]\` **(S)** Add a velocity stats pill near the pipeline section: "X SP/week avg", "Y SP completed", "Z SP total". Use existing \`lensStats\` rendering pattern.

## Acceptance Criteria
- [ ] AC1: Parser extracts S/M/L sizes from task descriptions and computes Fibonacci story points (S=1, M=3, L=5) per run
- [ ] AC2: Dashboard displays a velocity line chart with daily completed SP and cumulative SP on independent axes
- [ ] AC3: Stats show average SP/week and total completed SP
- [ ] AC4: Tasks without size labels default to S=1 without errors

**Upstream dependency:** stevegrocott/claude-pipeline will add \`task_summary\` to status.json — this issue should handle both with and without that field.

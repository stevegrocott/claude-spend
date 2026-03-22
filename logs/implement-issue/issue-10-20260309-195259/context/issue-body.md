## Context

Multiple sections of the dashboard show static aggregate stat cards for orchestrator metrics that change over time. There's no way to see trends — whether the pipeline is improving or degrading. Replacing these with small time-series charts (sparkline-style with the current aggregate value prominent) shows trajectory.

## Research Findings

**Data available in API:** Each orchestrator run has \`date\`, \`state\`, \`qualityIterations\`, \`testIterations\`, \`estimatedCost\`. There are 122 runs across 20 dates — sufficient for meaningful time series.

**Static cards to replace with time-series charts:**

**Cost section** (\`renderCostSection()\`, lines 1837-1854):
- "Pipeline Runs" (total count) → Runs per day line chart
- "Error Runs" (total errors) → Error rate % per day line chart

**Quality section** (\`renderQualitySection()\`, lines 1884-1944):
- "Completion Rate" (14%) → Daily completion % line chart
- "Avg Quality Loops" (3.3) → Daily avg quality iterations line chart
- "Avg Test Loops" (3.2) → Daily avg test iterations line chart

**Speed section** — already has a stage duration bar chart, no change needed.

**Files affected:**
- \`src/public/index.html\` — \`renderCostSection()\` (lines 1837-1854) and \`renderQualitySection()\` (lines 1884-1944)

**Current behavior:** Static stat cards showing single aggregate numbers.

**Desired behavior:** Canvas-based mini charts (compact 120px height) showing the metric over time as a line chart with dots. Current aggregate value overlaid as a large label. Each chart uses the existing DPR/canvas rendering pattern from ratioChart, outputRatioChart, etc.

## Evaluation

**Approach:** Replace stat-card divs with canvas elements inside chart-cards. Add render functions that group \`DATA.orchestrator.runs\` by date, calculate daily metrics, and plot time-series lines.

**Rationale:** Pure frontend change — no API modifications. Follows existing canvas chart pattern. Keeps aggregate values visible as overlays.

**Risks:**
- Charts in 2-column (cost) or 3-column (quality) grid may be cramped → Mitigation: 120px height, minimalist gridlines
- Single-run dates may be noisy → Mitigation: add 3-run moving average line

## Implementation Tasks

- [ ] \`[default]\` **(S)** Add a shared helper function \`renderMiniTimeSeries(canvasId, dailyData, opts)\` in \`src/public/index.html\` near line 2460 that accepts: canvas ID, array of \`{date, value}\`, and options \`{color, label, format, thresholds}\`. It should: set up DPR canvas, draw gridlines, plot line+dots, draw 3-point moving average in lighter color, and overlay the aggregate label top-left. Use the same pattern as \`renderOutputRatioChart()\` (line 2366). Scope: 1 file. Done when: function renders a chart given test data.
- [ ] \`[default]\` **(S)** Update \`renderCostSection()\` in \`src/public/index.html\` (lines 1837-1854) to replace the 2 stat-card divs with 2 canvas chart-cards. Group \`DATA.orchestrator.runs\` by date to calculate: (1) runs per day, (2) error rate % per day. Call \`renderMiniTimeSeries()\` for each. Scope: 1 file, ~20 lines. Done when: Cost section shows 2 mini charts.
- [ ] \`[default]\` **(S)** Update \`renderQualitySection()\` in \`src/public/index.html\` (lines 1884-1944) to replace the 3 stat-card divs (lines 1894-1902) with 3 canvas chart-cards. Group runs by date to calculate: (1) daily completion %, (2) daily avg quality iterations, (3) daily avg test iterations. Call \`renderMiniTimeSeries()\` for each. Keep Run Outcomes and Churners as-is below the charts. Scope: 1 file, ~30 lines. Done when: Quality section shows 3 mini charts + existing outcomes/churners.
- [ ] \`[default]\` **(S)** Update Playwright tests in \`tests/dashboard-cards.spec.js\` to verify the 5 new canvas elements exist in the cost and quality lens sections. Update or remove any tests that reference the old stat-card structure for these metrics. Scope: 1 file. Done when: all Playwright tests pass.

## Acceptance Criteria

- [ ] AC1: Cost lens section shows 2 canvas mini charts (runs/day, error rate/day) instead of 2 static cards
- [ ] AC2: Quality lens section shows 3 canvas mini charts (completion rate, quality loops, test loops) instead of 3 static cards
- [ ] AC3: Each chart shows the metric over time as a line with dots
- [ ] AC4: Current aggregate value is visible as an overlay label on each chart
- [ ] AC5: Charts follow existing canvas rendering pattern (DPR scaling, gridlines)
- [ ] AC6: Run Outcomes and Churners sections remain unchanged
- [ ] AC7: All Playwright tests pass

## Context
The dashboard shows current-state efficiency metrics but doesn't track whether user behavior is **improving over time**. Users need time-series trend lines to see if their sessions are getting shorter, context is staying leaner, and pipeline adoption is growing. Without trends, the recommendations are abstract — with trends, users can see the direct impact of behavioral changes.

## Research Findings

**Data available (from daily session aggregation):**
- 29 days of interactive session data (2026-02-15 to 2026-03-20)
- Daily: session count, token count, query count, model breakdown, session length distribution
- All data is already date-filterable via \`applyDateFilter()\`

**Four trackable behavior metrics identified (with actual data showing weekly variance):**

| Metric | Direction | Target | Current Range | Tracks |
|--------|-----------|--------|---------------|--------|
| Avg Queries/Session | Lower = better | <20 | 45–104/day | Session discipline — breaking work into focused sessions |
| Tokens/Query | Lower = better | <50K | 51K–171K/day | Context bloat — leaner conversation windows |
| Pipeline Coverage % | Higher = better | >40% | 12–54%/day | Structured work adoption |
| Short Session % (≤20 queries) | Higher = better | >50% | 26–55%/day | Focused session habits |

**Files affected:**
- \`src/parser.js\` — compute daily efficiency metrics array (\`efficiencyByDay\`) in \`computeSessionEfficiency()\`
- \`src/public/index.html\` — add "Efficiency Trends" section with 4 canvas line charts, 7-day rolling average smoothing, and target reference lines

**Current behavior:** Dashboard shows point-in-time efficiency data. No way to see improvement trends.
**Desired behavior:** 4 small line charts showing daily values with 7-day rolling average overlays and target lines, positioned in the Session Efficiency section.

## Evaluation
**Approach:** Compute \`efficiencyByDay\` array in the parser (server-side), with a client-side equivalent in \`recomputeSessionEfficiency()\` for date filtering. Render as 4 compact line charts (2x2 grid) in the Session Efficiency section using the existing canvas pattern.
**Rationale:** Follows the established pattern — parser computes, client recomputes on filter, canvas renders. The 2x2 grid reuses the \`.drivers-grid\` CSS pattern from the PP/100MT driver charts.

**Risks:**
- Daily variance makes raw data noisy — mitigate with 7-day rolling average overlay
- Days with <3 sessions produce unreliable averages — mitigate by showing dot size proportional to session count

## Implementation Tasks
- [ ] \`[default]\` **(S)** In \`src/parser.js\`, add \`efficiencyByDay\` computation to \`computeSessionEfficiency()\`: for each date with interactive sessions, compute \`{date, avgQueriesPerSession, tokensPerQuery, pipelineCoveragePct, shortSessionPct, sessionCount}\`. Include in the return object. Also update client-side \`recomputeSessionEfficiency()\` in \`src/public/index.html\` with the same daily aggregation so date filtering recomputes the trends.
- [ ] \`[default]\` **(M)** In \`src/public/index.html\`, add an "Efficiency Trends" subsection inside \`#sessionEfficiencySection\` after the context cost chart. Use a 2x2 \`.drivers-grid\` layout with 4 \`.driver-card\` elements, each containing a \`<canvas>\` and a title. Render with a shared \`renderEfficiencyTrendChart(canvasId, data, options)\` function that draws: (1) raw daily values as small dots, (2) 7-day rolling average as a smooth line, (3) a dashed horizontal target line with label. Each chart uses \`efficiencyByDay\` from \`FILTERED.sessionEfficiency\`. Chart configs: (a) "Queries/Session" — field \`avgQueriesPerSession\`, color amber, target 20 (green dashed), lower=better. (b) "Tokens/Query (K)" — field \`tokensPerQuery\` divided by 1000, color rose, target 50 (green dashed), lower=better. (c) "Pipeline Coverage %" — field \`pipelineCoveragePct\`, color indigo, target 40 (green dashed), higher=better. (d) "Short Sessions %" — field \`shortSessionPct\`, color teal, target 50 (green dashed), higher=better. Call from \`renderSessionEfficiency()\`. Add to resize handler.
- [ ] \`[default]\` **(S)** Update Playwright tests in \`tests/dashboard-cards.spec.js\`: add tests that the 4 trend chart canvases exist (\`#trendQueriesChart\`, \`#trendTpqChart\`, \`#trendPipelineChart\`, \`#trendShortChart\`), and that they render with non-zero dimensions when session data exists.

## Acceptance Criteria
- [ ] AC1: 4 trend charts render in a 2x2 grid showing daily values with 7-day rolling average
- [ ] AC2: Each chart has a labeled target line (20 queries, 50K tokens, 40% pipeline, 50% short)
- [ ] AC3: Charts respect the date picker — narrowing the range updates the trends
- [ ] AC4: Playwright tests pass for new chart elements

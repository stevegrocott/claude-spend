## Context

Charts within the same Speed lens section show different X-axis date ranges. Session-derived charts (Tokens per Query, Read:Write Ratio) span the full session history (e.g. Feb 2 – Mar 12), while pipeline-derived charts (Implement, PR_Review, PR stage durations) only span the dates with orchestrator runs (e.g. Mar 8 – Mar 12). This makes visual comparison between charts in the same section misleading.

## Research Findings

**Files affected:**
- `src/public/index.html` — `renderMiniTimeSeries()` function (line ~1987) and its callers

**Current behavior:** Each chart independently scales its X-axis to fit only its own data points. `renderMiniTimeSeries()` computes X positions as `i / (dailyData.length - 1)`, so a 5-day pipeline chart fills the same width as a 40-day session chart.

**Desired behavior:** All charts within the same lens section share the same X-axis date range. Pipeline charts that lack data for earlier dates should show empty space (no line) for those dates, keeping the timeline aligned.

## Evaluation

**Approach:** Pass an optional `dateRange` parameter to `renderMiniTimeSeries()` that defines the shared min/max dates. When provided, X positions are calculated relative to the full range, and only dates with data get plotted points.

**Rationale:** This is the minimal change — it doesn't alter the standalone behavior of charts that don't pass a range, and it allows each lens section's render function to compute and share a unified range.

**Risks:**
- Pipeline-only charts may appear very compressed on the right if the session range is much wider — mitigated by still showing dots and lines for actual data points
- Performance is not a concern — these are small datasets (<100 data points)

**Alternatives considered:**
- Truncate session charts to match pipeline range — rejected because it hides useful session trend data
- Use Chart.js with shared X-axis config — rejected because the project uses custom canvas rendering, not Chart.js

## Implementation Tasks

- [ ] `[default]` **(M)** Add optional `dateRange` parameter to `renderMiniTimeSeries()` in `src/public/index.html`. When provided as `{from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}`, compute X positions relative to the full range instead of the data array index. Fill missing dates with gaps in the line (moveTo instead of lineTo). Update X-axis labels to span the full range.
  - **Affected files:** `src/public/index.html`
- [ ] `[default]` **(S)** In `renderSpeedSection()` (called from `renderCostSection`/`renderSpeedSection`/`renderQualitySection`), compute the unified date range from both session `dailyUsage` dates and orchestrator run dates. Pass this range to all `renderMiniTimeSeries()` calls within the same lens section.
  - **Affected files:** `src/public/index.html`
- [ ] `[default]` **(S)** Apply the same unified date range to Quality lens mini time-series (completion %, avg quality iterations, avg test iterations) so they align with session-derived charts in that section.
  - **Affected files:** `src/public/index.html`

## Acceptance Criteria

- [ ] AC1: All charts within the Speed lens section share the same X-axis date range
- [ ] AC2: All charts within the Quality lens section share the same X-axis date range
- [ ] AC3: Pipeline charts with fewer data points show gaps (no line) for dates without data, rather than compressing the timeline
- [ ] AC4: Charts with no shared range parameter (e.g. Cost lens charts that are all from the same data source) continue to work as before

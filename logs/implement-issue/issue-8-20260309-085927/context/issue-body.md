## Context
The dashboard currently has fragmented sections (Recommendations, Insights, Pipeline Efficiency, Charts) that don't align with the Three-Lens (Cost/Speed/Quality) framework. Recommendations duplicate insights with generic information. Pipeline Efficiency sits in its own section instead of feeding the lens stats. Projects are mangled — orchestrator worktree sessions appear as separate "projects" (e.g., `claude-spend-logs-implement-issue-issue-21-...`). The lens selector only reorders existing insight cards but doesn't provide time-series metrics or charts per lens.

## Research Findings

**Files affected:**
- `src/public/index.html` — HTML structure, CSS, all render functions (renderRecommendations, renderInsights, renderPipeline, renderDailyChart, renderProjectBreakdown, etc.)
- `src/parser.js` — `clientGenerateInsights()`, `clientGenerateRecommendations()`, project grouping logic, daily/model aggregation

**Current structure (top to bottom):**
1. Stats Cards (4 cards: Total Usage, Conversations, Messages Sent, Claude Wrote)
2. Recommendations (4 categories: Model, Context, Conversation, Pipeline — generic tips)
3. Insights (lens buttons sort cards, 3 stat pills per lens, insight cards with Create Issue)
4. Pipeline Efficiency (4 stat cards, Run Outcomes chart, Performance/Churners chart)
5. Charts (Tokens/Day, By Model, Read:Write Ratio, Tokens/Query, Model Tier Mix)
6. Projects (table — broken: worktree paths appear as separate projects)
7. Most Expensive Prompts
8. Sessions (table with search, sort, drilldown)

**Current problems:**
- Recommendations are "Use Sonnet for simple tasks" level — not actionable pipeline improvements
- Pipeline Efficiency section has data that should feed into Quality (completion rate, churn) and Speed (stage durations) lenses
- Insights focus on user behavior ("you sent vague messages") not pipeline improvement ("your implement stage takes 3x longer than parse")
- Projects section counts each worktree path as a separate project — `encodeProjectPath()` in parser.js doesn't normalize worktree paths back to parent project
- Charts are global, not lens-specific — no cost-over-time, speed-over-time, or quality-over-time graphs
- Lens stat pills are static values, not time-series

**Desired structure:**
1. Stats Cards (keep as overview)
2. **Cost Lens Section** — estimated cost trend chart (daily $), model tier mix chart, cost-related insights (wasted escalation, vague prompts), actionable pipeline recommendations to reduce cost
3. **Speed Lens Section** — pipeline duration trend chart, stage bottleneck chart, speed-related insights (stage bottlenecks, parallel speedup), actionable pipeline recommendations to improve throughput
4. **Quality Lens Section** — completion rate trend chart, quality churn chart, quality-related insights (first-pass approval, error patterns), actionable pipeline recommendations to improve first-pass rate
5. Projects (fixed — normalize worktree paths to parent project)
6. Sessions (keep, date-filtered)

All sections filtered by date picker. Lens buttons become section navigation anchors.

## Evaluation
**Approach:** Restructure the single-page dashboard into three lens sections, each containing its relevant charts (moved from the current Charts/Pipeline sections), filtered insights, and pipeline-specific recommendations. Remove the standalone Recommendations and Pipeline Efficiency sections. Fix project grouping by normalizing worktree paths.

**Rationale:** The Three-Lens framework was added as a sort mechanism on top of the existing structure. This refactor makes each lens a first-class section with its own time-series charts, giving users a clear "here's your cost trend, here's what to change in the pipeline to improve it" view. Merging pipeline data into lens sections eliminates the duplicate Pipeline Efficiency section.

**Risks:**
- Large frontend refactor touching most render functions — mitigated by comprehensive E2E test suite (49 tests)
- Chart.js canvas reuse — each chart needs a unique canvas; moving them to new sections requires updating IDs — mitigated by task-level testing

**Alternatives considered:**
- Keep separate Pipeline section, just improve recommendations — rejected because it maintains the fragmentation problem
- Add tabs/pages per lens — rejected because single-page scrolling is simpler and the data volume doesn't warrant pagination

## Implementation Tasks
- [ ] `[default]` **(S)** Fix project grouping in `src/parser.js` — normalize worktree paths (matching pattern `*-logs-implement-issue-*`) back to parent project path. Affected function: project aggregation around lines 260-332 and the `applyDateFilter` recalculation around lines 1546-1600. Test: projects list should show ~4-5 entries, not 25.
- [ ] `[default]` **(M)** Restructure `src/public/index.html` HTML layout — replace Recommendations + Insights + Pipeline Efficiency + Charts sections with three lens sections (Cost, Speed, Quality). Each section gets: a header, stat summary pills, chart canvases (moved from current Charts section), insight cards, and pipeline recommendations. Remove `#recsSection` and `#pipelineSection` entirely. Move `#dailyChart` + `#tierMixChart` → Cost section; `#tpqChart` + `#ratioChart` → Speed section; add new canvases for quality metrics. Keep lens buttons as section anchor navigation.
- [ ] `[default]` **(M)** Refactor render functions in `src/public/index.html` — replace `renderRecommendations()` and `renderPipeline()` with `renderCostSection()`, `renderSpeedSection()`, `renderQualitySection()`. Each renders: (1) lens stat pills from pipeline + session data, (2) relevant charts, (3) filtered insights where `insight.lens === sectionLens`, (4) 1-2 actionable pipeline recommendations derived from orchestrator data. The `render()` function calls these three instead of the old five. `setLens()` becomes scroll-to-section navigation.
- [ ] `[default]` **(S)** Refocus insights on pipeline actionability in `src/parser.js` — update `clientGenerateInsights()` to frame insights as pipeline improvements: "Your implement stage averages 45min — split tasks under 3 files" instead of "You sent vague messages". Each insight's `action` field should reference a specific pipeline config or skill change (e.g., "Add file paths to task descriptions in explore skill", "Increase quality loop limit in model-config.sh"). Remove `clientGenerateRecommendations()` entirely.
- [ ] `[default]` **(S)** Wire date picker filtering to all lens sections — ensure `applyDateFilter()` recalculates lens-specific metrics (cost/day, pipeline duration trends, quality rate trends) from filtered data. Orchestrator runs should also be date-filtered (currently they use unfiltered `DATA.orchestrator`). Update the `FILTERED` object to include per-lens aggregations.
- [ ] `[default]` **(S)** Update Playwright E2E tests in `tests/dashboard-cards.spec.js` — replace Pipeline Efficiency tests with Cost/Speed/Quality section tests. Update stat card counts, section selectors, and chart canvas IDs to match new layout. Remove recommendation section tests. Add tests verifying each lens section has charts, insights, and stat pills.

## Acceptance Criteria
- [ ] AC1: Dashboard shows three lens sections (Cost, Speed, Quality) each with charts, insights, and stat pills — no separate Recommendations or Pipeline Efficiency sections
- [ ] AC2: All charts are organized under relevant lens (cost charts under Cost, efficiency charts under Speed, quality metrics under Quality)
- [ ] AC3: Insights are pipeline-actionable — each insight's action references a specific pipeline config, skill, or workflow change
- [ ] AC4: Projects section shows ~4-5 actual projects, not 25 (worktree paths normalized)
- [ ] AC5: Date picker filters all sections including lens metrics and orchestrator data
- [ ] AC6: All Playwright E2E tests pass with updated assertions

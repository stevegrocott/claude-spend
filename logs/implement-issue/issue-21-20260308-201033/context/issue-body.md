## Context
Playwright E2E tests (49 tests, `tests/dashboard-cards.spec.js`) revealed that 4 of 8 dashboard sections don't render at all, and the insights section has data inconsistencies. 30/49 tests pass (stats, recommendations, charts, header), 19 fail. The failures likely share a cascade root cause — a JS error in an early render function prevents later sections from executing.

## Research Findings

**Files affected:**
- `src/parser.js` — lens values returned as `"Cost"` (capitalized) instead of `"cost"` (lowercase)
- `src/public/index.html` — `render()` function calls sections sequentially; error in one blocks all subsequent

**Current behavior:**
1. **Lens values capitalized:** API returns `"Cost"`, `"Speed"`, `"Quality"` but `LENS_SCORES` map in `index.html` uses lowercase keys — `lensScore()` silently returns 0 for all insights
2. **Only 10 of 20 insights rendered:** Half the insights are silently dropped despite API returning 20
3. **Pipeline section hidden:** `renderPipeline()` hides the section despite API having 109 runs — likely a data structure mismatch after the metrics.json enhancement
4. **Projects, Top Prompts, Sessions sections empty:** Zero DOM elements rendered despite API returning 20 projects, 20 prompts, 1,547 sessions. These render functions are called after `renderPipeline()` in the `render()` chain — a JS error in pipeline cascades

**Desired behavior:** All 8 sections render with content matching API data. All 49 Playwright tests pass.

## Evaluation
**Approach:** Fix in dependency order — lens normalization first (parser), then debug the render cascade (index.html), then fix individual section rendering issues.

**Rationale:** The cascade hypothesis explains 15 of 19 failures from a single root cause. Fixing `renderPipeline()` should unblock projects/prompts/sessions. The lens capitalization is a separate parser bug.

**Risks:**
- Render cascade may have multiple independent failures — mitigated by fixing and testing one section at a time
- Large session count (1,547) may cause DOM performance issues — mitigated by checking if pagination exists

**Alternatives considered:**
- Add try/catch around each render function — rejected because it hides errors rather than fixing them
- Rewrite render chain as independent — rejected because the sequential approach is fine once the error is fixed

## Implementation Tasks
- [ ] `[default]` **(S)** Fix lens value capitalization in `src/parser.js` — normalize all `insight.lens` values to lowercase before returning from `generateInsights()`. Search for where lens is assigned (grep for `lens:` in parser.js) and add `.toLowerCase()` or change source strings to lowercase.
- [ ] `[default]` **(S)** Debug and fix `renderPipeline()` in `src/public/index.html` — open browser console on http://localhost:3456, identify the JS error, fix the data structure mismatch. The function checks `RAW_DATA.orchestrator.summary.totalRuns > 0` but the data path may differ. Add `console.log(RAW_DATA.orchestrator)` temporarily to diagnose.
- [ ] `[default]` **(S)** Fix insight count mismatch — investigate why only 10 of 20 insights render. Check if there's a `.slice(0, 10)` or a filter in `renderInsights()` or in the data pipeline. If intentional, update test expectations; if a bug, remove the cap.
- [ ] `[default]` **(S)** Verify projects, top prompts, and sessions render after pipeline fix — if the cascade hypothesis is correct, these should work once `renderPipeline()` is fixed. If they still fail, debug each individually by checking `#projectsBody`, `#topPromptsList`, `#sessionsBody` DOM targets exist and `FILTERED` data is populated.
- [ ] `[default]` **(S)** Run full Playwright test suite (`npx playwright test --reporter=list`) and verify all 49 tests pass. Fix any remaining test selector mismatches (e.g., `.proj-row` vs actual class names).

## Acceptance Criteria
- [ ] AC1: All 49 Playwright tests in `tests/dashboard-cards.spec.js` pass
- [ ] AC2: Lens selector (Cost/Speed/Quality) correctly prioritizes and reranks insights
- [ ] AC3: Pipeline Efficiency section visible with stat cards showing run count, completion rate, quality/test loops
- [ ] AC4: Projects section renders all projects with name, tokens, sessions, queries
- [ ] AC5: Top Prompts section renders with rank, text, and token bars
- [ ] AC6: Sessions table renders all sessions with date, model badge, and token counts
- [ ] AC7: No JavaScript errors in browser console on page load

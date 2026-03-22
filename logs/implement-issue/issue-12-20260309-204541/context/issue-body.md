## Context

The recommendations engine shows cumulative API-rate dollar savings (e.g., "~\$39,130.74 est.") that are misleading for Claude Code subscription users. Claude Code uses Max plan pricing (\$100/\$200 per month), not per-token API billing. The real constraint is running out of tokens within the 5-hour rolling window and weekly cap — not dollars. Recommendations should help users stretch their token budget, not quote fictional API costs.

Additionally, many dashboard cards and chart titles lack explanatory tooltips, making it hard for users to understand what each metric means at a glance.

## Research Findings

**Files affected:**
- `src/public/index.html` — `REC_PRICING` constant (line 1080), `recEstimateCost()` (line 1088), `recFmtDollars()` (line 1092), `clientGenerateRecommendations()` (lines 1098-1278), saving badge rendering (line 1301), section titles, chart card titles, lens stat pill labels

**Current behavior:**
- `REC_PRICING` uses outdated API rates: Opus at \$15/\$75, Sonnet at \$3/\$15, Haiku at \$0.80/\$4
- All savings are cumulative over the entire date range (e.g., 3 months of data = 3 months of "savings")
- Dollar amounts are displayed as `~\$39130.74 est.` — meaningless for subscription users
- The "74% of tokens use Opus" recommendation multiplies total Opus cost × 0.4 as "savings"
- Many titles lack tooltips: Recommendations section title, recommendation lens titles (Model/Context/Conversation/Pipeline), Insights section title, lens stat pills, lens chart titles, Pipeline Efficiency section title, pipeline mini chart titles, Projects section title, Sessions section title

**Desired behavior:**
- Replace dollar framing with **token savings per month** and **% headroom gained**
- Normalize all metrics to per-month averages (using date range span)
- Frame around Max plan token budget: "saves ~X tokens/month → Y% more headroom per window"
- Update API pricing constants to current Claude 4.6 rates for accurate relative comparisons
- Show token-budget badges instead of dollar badges on recommendation cards
- Add explanatory tooltips to all card titles, section titles, chart titles, and lens stat pill labels using the existing `has-tooltip` CSS pattern

**Current Claude 4.6 API rates (for relative cost weighting only):**
- Opus 4.6: \$5/\$25 per MTok (input/output)
- Sonnet 4.6: \$3/\$15 per MTok
- Haiku 4.5: \$1/\$5 per MTok

**Max plan context:**
- Max 5x: \$100/month, 5× Pro usage limits
- Max 20x: \$200/month, 20× Pro usage limits
- Constraint is 5-hour rolling window token budget + weekly cap
- Real benefit of optimization: not hitting rate limits, more productive time

## Evaluation

**Approach:** Replace dollar-based savings with token-based metrics normalized to per-month, framed as headroom within the Max plan token budget. Add tooltips to all dashboard titles using the existing `has-tooltip` pattern.

**Rationale:** Claude Code users are subscription-based. Dollar amounts are meaningless and actively misleading (showing \$39K for a \$100/month plan). Token savings directly translate to "more work before hitting rate limits" which is the actual pain point. Tooltips improve discoverability for new users.

**Risks:**
- Per-month normalization requires knowing the date range span — mitigated by using `FILTERED.totals.dateRange` which is already available
- Token numbers may be large and hard to parse — mitigated by using `fmt()` (e.g., "2.1M tokens/mo") which already exists

**Alternatives considered:**
- Keep dollars but normalize to per-month — rejected because dollars are still meaningless for subscription users
- Show both dollars and tokens — rejected because dollars add confusion without value
- Map to exact Max plan limits — rejected because Anthropic's exact token budgets per window are opaque and change frequently

## Implementation Tasks

- [ ] `[default]` **(S)** Update `REC_PRICING` in `src/public/index.html` (line 1080) to current Claude 4.6 API rates: opus `{input: 5, output: 25}`, sonnet `{input: 3, output: 15}`, haiku `{input: 1, output: 5}`. These are used only for relative cost weighting between tiers, not for dollar display. Scope: 1 file, 1 line. Done when: pricing constants match current rates.
- [ ] `[default]` **(S)** Add a `dateRangeMonths()` helper near `recFmtDollars` in `src/public/index.html` (~line 1096) that computes the number of months spanned by the current `FILTERED.totals.dateRange` (min 1 month). Replace `recFmtDollars()` with `recFmtTokenSaving(totalTokensSaved)` that normalizes to per-month using `dateRangeMonths()` and formats as e.g., "~1.2M tokens/mo". Scope: 1 file, ~15 lines. Done when: new formatter produces readable per-month token strings.
- [ ] `[default]` **(M)** Rewrite all saving calculations in `clientGenerateRecommendations()` (lines 1098-1275) in `src/public/index.html` to use token savings instead of dollar savings. For each recommendation that currently computes dollar savings: (1) calculate the token difference instead (e.g., Opus tokens that would become Sonnet tokens = same tokens, just cheaper per unit — reframe as "tokens saved by using a lighter model that consumes less of your budget"), (2) store as `saving: { tokens: N, label: '~1.2M tokens/mo' }` instead of a dollar number. Update recommendation text strings to remove dollar references and use token/headroom language. For the "74% Opus" rec (line 1134): replace `recEstimateCost(opusInp, opusOut, 'opus') * 0.4` with actual token savings calculation — Opus costs ~1.67x more budget per token than Sonnet (ratio of API rates as proxy for budget consumption), so shifting 40% of Opus to Sonnet saves `opusTokens * 0.4 * (1 - sonnetRate/opusRate)` effective tokens. Scope: 1 file, ~40 lines. Done when: all `saving` fields use token-based values, no dollar strings remain in recommendation text.
- [ ] `[default]` **(S)** Update the saving badge rendering in `renderRecommendations()` (line 1301) in `src/public/index.html` to display `rec.saving.label` (e.g., "~1.2M tokens/mo") instead of `~${recFmtDollars(rec.saving)} est.`. Update the `.rec-saving` CSS class (line 320) if needed for wider badges. Scope: 1 file, ~5 lines. Done when: badges show per-month token savings instead of dollar amounts.
- [ ] `[default]` **(M)** Add explanatory tooltips to all card and chart titles in `src/public/index.html` that currently lack them. Use the existing `has-tooltip` CSS pattern (hover to reveal). Titles needing tooltips: (1) Recommendations section title (line 773) — "Actionable suggestions to reduce token usage, ranked by potential impact"; (2) Recommendation lens titles rendered in `renderRecommendations()` (line 1315) — Model: "Switch to cheaper models for simple tasks", Context: "Reduce tokens Claude re-reads each turn", Conversation: "Optimize session length and prompt specificity", Pipeline: "Improve automated pipeline efficiency"; (3) Insights section title (line 784) — "Data-driven observations about your usage patterns"; (4) Lens stat pills rendered in `renderInsights()` (line 1724) — add a `tip` field to each lensStats entry and render as tooltip; (5) Pipeline Efficiency section title (line 807) — "Automated pipeline run metrics from orchestrator logs"; (6) Pipeline mini chart titles in HTML (lines 810-816) — Runs per Day: "Number of orchestrator pipeline runs each day", Error Rate: "Percentage of runs that ended in error each day", Completion %: "Percentage of runs that completed successfully each day", Quality Iterations: "Average quality review loops per run each day", Test Iterations: "Average test fix loops per run each day"; (7) Projects section title (line 878) — "Token usage broken down by project/codebase"; (8) Sessions section title (line 925) — "Every conversation with Claude, sorted by token cost". Scope: 1 file, ~30 lines. Done when: hovering any title shows an explanatory tooltip.
- [ ] `[default]` **(S)** Update Playwright tests in `tests/dashboard-cards.spec.js` — the test "each recommendation has text content and optional saving badge" (line 112) should verify that saving badges, when present, contain "tokens/mo" not dollar signs. Add a test that pipeline chart titles have tooltips. Scope: 1 file, ~10 lines. Done when: all Playwright tests pass.

## Acceptance Criteria

- [ ] AC1: No dollar amounts appear anywhere in recommendations text or badges
- [ ] AC2: Saving badges show per-month token savings (e.g., "~1.2M tokens/mo")
- [ ] AC3: All token savings are normalized by the date range span (not cumulative)
- [ ] AC4: `REC_PRICING` uses current Claude 4.6 API rates
- [ ] AC5: Recommendation text frames optimization as "more headroom" / "fewer tokens consumed" rather than "money saved"
- [ ] AC6: All card titles, section titles, chart titles, and lens stat pill labels have explanatory hover tooltips
- [ ] AC7: All existing Playwright tests pass

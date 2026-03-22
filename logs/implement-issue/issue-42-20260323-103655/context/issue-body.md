## Context
All four orchestrator charts (Yield % Trend, Task Size Completion, Failure Breakdown, Task Count vs Outcome) use different populations, creating contradictions. The root cause: \"Still Running\" runs (non-terminal state) are included in some denominators and excluded from others. The fix: **all charts must filter to the same terminal-state-only population**.

## Research Findings

**Files affected:**
- \`src/parser.js\` lines 705-751 — \`yieldByDay\` using \`storyPointsTotal\` (includes Still Running)
- \`src/parser.js\` lines 1334-1352 — \`taskSizeCompletion\` using \`completed + failed\` (excludes Still Running)
- \`src/public/index.html\` lines 1300-1461 — \`recomputeOrchestratorSummary\` + \`recomputePpmtAnalysis\`

**The contradiction (visible in screenshot):**
- Yield % Trend: ~25% on Mar 23
- Task Size Completion: S=97%, M=100%, L=100%
- **Failure Breakdown: Still Running = 16**
- Task Count vs Outcome: avg 3 completed vs 3 failed

**Why Still Running = 16 causes the contradiction:**
- Yield % denominator: `storyPointsTotal` counts ALL attempted SP including those in the 16 still-running runs
- Task Size Completion denominator: `completed + failed` — the 16 still-running runs contribute zero to either bucket, so they are invisible
- Result: yield tanks because ~16 runs worth of story points are in the denominator with zero completions, while task completion rate looks healthy because those same runs are simply absent

**Desired behavior:** All four charts filter to identical run population. Two valid options:
1. **Exclude Still Running from all** — only count runs in terminal states (recommended: honest view of what's actually done)
2. **Include Still Running in all** — count their in-progress story points as unresolved failures everywhere

Option 1 is recommended: "Still Running" should remain its own diagnostic metric (the Failure Breakdown can keep showing it as a separate category), but it should not pollute the yield denominator.

## Evaluation
**Approach:** Add a terminal-run filter at the data computation layer in `parser.js` — when building `yieldByDay`, skip runs where state is `'running'` or equivalent non-terminal states. Similarly audit `recomputeOrchestratorSummary` in `index.html` client-side recompute.

**Risks:**
- Changing yield denominator alters all historical numbers — mitigation: this is the correct behaviour, document the change
- Still Running runs need to remain visible somewhere — mitigation: Failure Breakdown keeps them as a category

**Alternatives considered:**
- Just adding explanatory labels — rejected: user explicitly wants alignment, not explanation

## Implementation Tasks
- [ ] \`[default]\` **(S)** In \`src/parser.js\` lines 705-751: identify the field/value that marks a run as \"Still Running\" (likely \`run.state === 'running'\` or similar); add a filter to exclude these runs from \`yieldByDay\` computation — read \`parseTaskSummary()\` (lines 48-69) and the run structure first
- [ ] \`[default]\` **(S)** In \`src/parser.js\` lines 1334-1352: verify \`taskSizeCompletion\` already excludes Still Running runs; if not, add the same filter to align it
- [ ] \`[default]\` **(S)** In \`src/parser.js\`: verify \`taskCountVsOutcome\` (avg completed vs avg failed) excludes Still Running runs; add filter if missing
- [ ] \`[default]\` **(S)** In \`src/public/index.html\` \`recomputeOrchestratorSummary()\` (lines 1300-1383): apply the same Still Running exclusion to the client-side yield recompute so date filtering stays consistent
- [ ] \`[default]\` **(S)** In \`src/public/index.html\` \`renderYieldTrendChart()\` (lines 2084-2142): add a subtitle note "terminal runs only (excludes Still Running)" so the filter is visible to the user

## Acceptance Criteria
- [ ] AC1: For any date range, Yield % and Task Size Completion aggregate rate are mathematically consistent (yield ≈ weighted average of size completion rates by story points)
- [ ] AC2: Still Running runs are excluded from Yield %, Task Size Completion, and Task Count vs Outcome denominators
- [ ] AC3: Still Running count remains visible in Failure Breakdown as a diagnostic category
- [ ] AC4: Yield % Trend chart subtitle indicates "terminal runs only"

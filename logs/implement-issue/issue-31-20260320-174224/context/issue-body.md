**Parent epic:** #30

## Context
74% of all tokens (8.1B of 11B) are spent in interactive Claude Code sessions outside the orchestrator pipeline. These sessions have no story point tracking and are invisible to PP/100MT. The dashboard needs a dedicated section analyzing non-pipeline usage patterns and generating actionable recommendations to help users get more value from these tokens.

## Research Findings

**Data source:** \`~/.claude/projects/\` JSONL files — Claude Code CLI sessions only (not Claude Desktop or claude.ai web).

**Token split (from correlation analysis):**
- Layer 1 — Pipeline subagent sessions: 2,473 sessions, 2.9B tokens (26%) — produce tracked SP
- Layer 2 — Interactive CC sessions: 576 sessions, 8.1B tokens (74%) — no SP tracking

**Non-pipeline session patterns identified:**

| Pattern | Sessions | Tokens | Insight |
|---------|----------|--------|---------|
| Marathon sessions (1000+ queries) | 11 | 3.0B (27%) | Context re-read dominates after ~50 queries. These sessions cost as much as a full day of pipeline runs each |
| Long sessions (100-1000 queries) | 126 | 2.2B (20%) | Diminishing returns — later queries burn 50x more tokens than early ones |
| Implementation-like prompts (fix/add/update) | 1,734 | 4.25B (39%) | Could earn SP if run through pipeline instead of manual CC sessions |
| Short sessions (1-50 queries) | 2,473 | 2.9B (26%) | Includes pipeline subagents + quick interactive. Efficient token use |

**Key non-pipeline recommendations the engine should generate:**

1. **Marathon session detection** — "11 sessions averaged 275M tokens each. After ~50 queries, each new query re-reads the entire conversation. Use \`/clear\` or start a new session." Include session date and first prompt for identification.
2. **Implementation work outside pipeline** — "1,734 sessions spent 4.25B tokens on implementation-like work (fix/add/update/create) without SP tracking. Running these through \`/implement-issue\` would track output and optimize token use via task sizing."
3. **Context balloon rate** — Show how token cost per query escalates as sessions grow longer. First 10 queries: ~50K tokens each. Queries 100+: ~2M tokens each (40x more). Visualize this curve.
4. **Pipeline coverage ratio** — "Only 26% of your tokens go through the pipeline. Increasing pipeline coverage directly improves PP/100MT by moving tokens from untracked to tracked."

**Files affected:**
- \`src/parser.js\` — compute non-pipeline session analysis: categorize sessions (pipeline subagent vs interactive), compute session length distribution, detect implementation-like prompts, calculate context balloon rate, generate non-pipeline recommendations
- \`src/public/index.html\` — add "Session Efficiency" section below PP/100MT driver charts showing: pipeline/interactive token split visualization, context cost curve, non-pipeline recommendations

**Current behavior:** Non-pipeline sessions are invisible — no analysis, no recommendations, no visibility into where 74% of tokens go.
**Desired behavior:** Dashboard shows pipeline vs interactive token split, identifies wasteful patterns in interactive sessions, and recommends specific actions to improve efficiency.

## Evaluation
**Approach:** Server-side analysis in the parser categorizes sessions and generates non-pipeline recommendations. Dashboard renders a "Session Efficiency" section with split visualization and recommendations.
**Rationale:** The data is already in the parser (session prompts, query counts, token totals). We just need to categorize and analyze it. Keeping analysis server-side maintains the pattern from issue #28.

**Risks:**
- Prompt classification heuristic may misclassify sessions — mitigate by using conservative matching and showing the prompt text so users can verify
- Users may not want to pipeline everything — mitigate by framing as "awareness" not "you must pipeline this"

## Implementation Tasks
- [ ] \`[default]\` **(S)** In \`src/parser.js\`, add \`computeSessionEfficiency(sessions)\` function that: (1) categorizes each session as \`pipeline_subagent\` (query count <= 50 AND prompt matches orchestrator patterns) or \`interactive\`, (2) computes token split between categories, (3) identifies marathon sessions (100+ queries) with date/firstPrompt/tokens, (4) counts implementation-like prompts (first prompt matches fix/add/update/create/build/refactor patterns), (5) computes context balloon curve: average tokens-per-query at query positions 1-10, 11-50, 51-100, 100+. Return as \`sessionEfficiency\` object in the API response alongside orchestrator summary.
- [ ] \`[default]\` **(S)** In \`src/parser.js\`, add \`generateSessionRecommendations(efficiency)\` that produces recommendations array: (a) marathon sessions if any session > 200 queries (cite specific sessions), (b) implementation outside pipeline if > 10 implementation-like sessions exist, (c) low pipeline coverage if pipeline tokens < 40% of total, (d) context balloon warning if avg tokens/query at position 100+ exceeds 10x position 1-10 average. Each recommendation has \`id\`, \`title\`, \`detail\` with specific numbers, \`action\`.
- [ ] \`[default]\` **(M)** In \`src/public/index.html\`, add a "Session Efficiency" section after the PP/100MT driver charts. Contains: (1) Pipeline vs Interactive token split — a horizontal stacked bar showing 26%/74% split with token counts, (2) Session recommendations — rendered like the Efficiency recommendations but for non-pipeline patterns, (3) Context cost curve — simple line chart showing average tokens-per-query at different session lengths (shows the exponential cost of long sessions). Explainer: "Tokens spent outside the pipeline don't produce tracked story points. These recommendations help you get more value from interactive sessions."
- [ ] \`[default]\` **(S)** Update Playwright tests in \`tests/dashboard-cards.spec.js\`: add tests for Session Efficiency section rendering, pipeline/interactive split bar, and session recommendations.

## Acceptance Criteria
- [ ] AC1: Dashboard shows pipeline vs interactive token split with percentages and token counts
- [ ] AC2: Non-pipeline recommendations cite specific session data (dates, token counts, query counts)
- [ ] AC3: Context cost curve visualizes the exponential token cost of long sessions
- [ ] AC4: PP/100MT calculation uses pipeline-only tokens as denominator (not total tokens)
- [ ] AC5: Playwright tests pass for new section

'use strict';

/**
 * Maps spend-analysis insights to GitHub issue structures.
 * Each actionable insight produces { title, body, labels } suitable for `gh issue create`.
 * Non-actionable insights (day-pattern, project-dominance) return null.
 */

const INSIGHT_MAPPINGS = {
  'vague-prompts': {
    titlePrefix: 'Reduce token waste from vague prompts',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: ['.claude/skills/using-skills/SKILL.md'],
    section: 'Token Awareness',
    tasks: [
      { agent: 'default', size: 'S', desc: 'Add prompt specificity examples to using-skills/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Add "vague prompt" anti-patterns with before/after examples to Token Awareness section' },
      { agent: 'default', size: 'S', desc: 'Document token cost multiplier effect of ambiguous instructions' },
    ],
    acceptanceCriteria: [
      'Token Awareness section in using-skills/SKILL.md includes at least 3 before/after prompt examples',
      'Anti-patterns section covers short vague messages like "Yes", "Do it", "Fix it"',
      'Cost impact explanation is included showing how vague prompts trigger extra tool calls',
    ],
  },

  'context-growth': {
    titlePrefix: 'Mitigate context growth in long conversations',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: [
      '.claude/skills/subagent-driven-development/SKILL.md',
      '.claude/skills/executing-plans/SKILL.md',
    ],
    section: 'Context Management',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Add conversation splitting guidelines to subagent-driven-development/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Add context summary handoff pattern to executing-plans/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Document when to start fresh conversations vs continue existing ones' },
    ],
    acceptanceCriteria: [
      'subagent-driven-development/SKILL.md includes conversation splitting guidelines',
      'executing-plans/SKILL.md includes context summary handoff pattern',
      'Guidelines specify token thresholds or message counts as splitting triggers',
    ],
  },

  'marathon-sessions': {
    titlePrefix: 'Reduce cost of marathon coding sessions',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: ['.claude/skills/using-skills/SKILL.md'],
    section: 'Session Management',
    tasks: [
      { agent: 'default', size: 'S', desc: 'Add session length guidelines to using-skills/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Document task-per-conversation pattern with recommended message limits' },
      { agent: 'default', size: 'S', desc: 'Add session checkpoint/handoff instructions for long-running work' },
    ],
    acceptanceCriteria: [
      'using-skills/SKILL.md includes recommended session length limits',
      'Task-per-conversation pattern is documented with examples',
      'Checkpoint/handoff instructions enable resuming work in fresh sessions',
    ],
  },

  'model-mismatch': {
    titlePrefix: 'Optimize model selection for simple tasks',
    labels: ['spend-analysis', 'cost-optimization'],
    targetFiles: ['.claude/scripts/model-config.sh'],
    section: 'Model Configuration',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Create or update .claude/scripts/model-config.sh with task-complexity routing rules' },
      { agent: 'default', size: 'S', desc: 'Add model selection decision tree (Opus for complex, Sonnet for standard, Haiku for simple)' },
      { agent: 'default', size: 'S', desc: 'Document /model switch patterns for common task types' },
    ],
    acceptanceCriteria: [
      'model-config.sh includes task-complexity routing configuration',
      'Decision tree covers at least 3 complexity tiers with model recommendations',
      'Common task types (quick questions, refactoring, architecture) are mapped to models',
    ],
  },

  'tool-heavy': {
    titlePrefix: 'Reduce excessive tool calls in agent workflows',
    labels: ['spend-analysis', 'agent-optimization'],
    targetFiles: ['.claude/agents/'],
    section: 'Tool Usage Optimization',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Audit agent .md files in .claude/agents/ for missing file path guidance' },
      { agent: 'default', size: 'S', desc: 'Add specific file targeting instructions to reduce exploratory tool calls' },
      { agent: 'default', size: 'S', desc: 'Document tool call reduction patterns (explicit paths, line numbers, grep before read)' },
    ],
    acceptanceCriteria: [
      'Agent definition files include file path guidance where applicable',
      'Tool call reduction patterns are documented with examples',
      'Before/after comparison shows expected tool call reduction',
    ],
  },

  'heavy-context': {
    titlePrefix: 'Reduce startup context overhead',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: ['.claude/skills/adapting-claude-pipeline/SKILL.md'],
    section: 'Token Efficiency Audit',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Add Token Efficiency Audit checklist to adapting-claude-pipeline/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Document CLAUDE.md pruning guidelines with size benchmarks' },
      { agent: 'default', size: 'S', desc: 'Add instructions for splitting large CLAUDE.md into focused skill files' },
    ],
    acceptanceCriteria: [
      'adapting-claude-pipeline/SKILL.md includes Token Efficiency Audit section',
      'CLAUDE.md pruning guidelines specify target size ranges',
      'Splitting strategy documents how to decompose monolithic config into skills',
    ],
  },

  'conversation-efficiency': {
    titlePrefix: 'Improve conversation efficiency ratio',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: ['.claude/skills/using-skills/SKILL.md'],
    section: 'Conversation Efficiency',
    tasks: [
      { agent: 'default', size: 'S', desc: 'Add conversation efficiency guidelines to using-skills/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Document cost-per-message growth curve and why shorter conversations save tokens' },
      { agent: 'default', size: 'S', desc: 'Add practical message count targets for different task types' },
    ],
    acceptanceCriteria: [
      'using-skills/SKILL.md includes conversation efficiency section',
      'Cost growth explanation covers the re-reading multiplier effect',
      'Message count targets are provided for at least 3 task categories',
    ],
  },

  'input-heavy': {
    titlePrefix: 'Address high input-to-output token ratio',
    labels: ['spend-analysis', 'token-efficiency'],
    targetFiles: [],
    section: 'Output Optimization',
    linkedIssue: 45,
    tasks: [
      { agent: 'default', size: 'S', desc: 'Link to and coordinate with issue #45 (output truncation)' },
      { agent: 'default', size: 'S', desc: 'Document input/output ratio awareness and its implications for session planning' },
    ],
    acceptanceCriteria: [
      'Issue is linked to #45 with cross-reference',
      'Input/output ratio implications are documented for session planning',
    ],
  },

  // --- Orchestrator-derived insights ---

  'quality-churn': {
    titlePrefix: 'Reduce quality loop churn in pipeline',
    labels: ['spend-analysis', 'pipeline-efficiency'],
    targetFiles: [
      '.claude/skills/subagent-driven-development/implementer-prompt.md',
      '.claude/skills/subagent-driven-development/code-quality-reviewer-prompt.md',
    ],
    section: 'Quality Loop Optimization',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Review and tighten implementer-prompt.md to address common quality review failures' },
      { agent: 'default', size: 'S', desc: 'Review code-quality-reviewer-prompt.md for overly strict or ambiguous criteria' },
      { agent: 'default', size: 'S', desc: 'Add self-review checklist items to implementer prompt targeting common review feedback' },
    ],
    acceptanceCriteria: [
      'Implementer prompt includes checklist targeting common quality review failures',
      'Reviewer prompt distinguishes blocking issues from style preferences',
      'Average quality loop iterations decreases in subsequent pipeline runs',
    ],
  },

  'test-churn': {
    titlePrefix: 'Reduce test loop churn in pipeline',
    labels: ['spend-analysis', 'pipeline-efficiency'],
    targetFiles: [
      '.claude/skills/subagent-driven-development/implementer-prompt.md',
      '.claude/skills/test-driven-development/SKILL.md',
    ],
    section: 'Test Loop Optimization',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Add explicit test-running instructions to implementer-prompt.md' },
      { agent: 'default', size: 'S', desc: 'Add test command examples to task description template in explore/SKILL.md' },
      { agent: 'default', size: 'S', desc: 'Document common test failure patterns and preventive measures' },
    ],
    acceptanceCriteria: [
      'Implementer prompt requires running tests before committing',
      'Task descriptions include specific test commands',
      'Average test loop iterations decreases in subsequent runs',
    ],
  },

  'low-completion-rate': {
    titlePrefix: 'Improve pipeline completion rate',
    labels: ['spend-analysis', 'pipeline-efficiency'],
    targetFiles: [
      '.claude/scripts/implement-issue-orchestrator.sh',
      '.claude/skills/explore/SKILL.md',
    ],
    section: 'Pipeline Reliability',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Audit error-state runs in orchestrator logs to identify common failure patterns' },
      { agent: 'default', size: 'S', desc: 'Add error recovery guidance to orchestrator' },
      { agent: 'default', size: 'S', desc: 'Improve task description quality in explore/SKILL.md to reduce parse failures' },
    ],
    acceptanceCriteria: [
      'Common error patterns documented with mitigations',
      'Orchestrator has improved error handling',
      'Completion rate increases above 50%',
    ],
  },

  'stage-bottleneck': {
    titlePrefix: 'Optimize slowest pipeline stage',
    labels: ['spend-analysis', 'pipeline-efficiency'],
    targetFiles: ['.claude/scripts/implement-issue-orchestrator.sh'],
    section: 'Stage Performance',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Analyze slowest stage for causes (task size, model tier, file reads)' },
      { agent: 'default', size: 'S', desc: 'Add task-splitting or timeout guidance for long-running stages' },
    ],
    acceptanceCriteria: [
      'Slowest stage cause identified and documented',
      'Mitigation implemented (splitting, timeout, or model tier change)',
    ],
  },

  'error-pattern': {
    titlePrefix: 'Address recurring pipeline error patterns',
    labels: ['spend-analysis', 'pipeline-efficiency'],
    targetFiles: [
      '.claude/scripts/implement-issue-orchestrator.sh',
      '.claude/skills/explore/SKILL.md',
    ],
    section: 'Error Reduction',
    tasks: [
      { agent: 'default', size: 'M', desc: 'Categorize error-state runs by failure type (parse, validation, implementation, test)' },
      { agent: 'default', size: 'S', desc: 'Add pre-flight validation for the most common error causes' },
      { agent: 'default', size: 'S', desc: 'Update explore/SKILL.md task format to prevent parse failures' },
    ],
    acceptanceCriteria: [
      'Error patterns categorized with frequency counts',
      'Top error cause has pre-flight validation',
      'Error rate decreases below 20%',
    ],
  },
};

// Non-actionable insight IDs that should return null
const SKIP_IDS = new Set(['day-pattern', 'project-dominance']);

/**
 * Maps an insight object to a GitHub issue structure.
 *
 * @param {Object} insight - Insight from the parser
 * @param {string} insight.id - Insight identifier
 * @param {string} insight.type - 'warning' | 'info' | 'neutral'
 * @param {string} insight.title - Human-readable title
 * @param {string} insight.description - Detailed description
 * @param {string|null} insight.action - Suggested action or null
 * @returns {{ title: string, body: string, labels: string[] } | null}
 */
function mapInsightToIssue(insight) {
  if (!insight || !insight.id) return null;
  if (SKIP_IDS.has(insight.id)) return null;

  const mapping = INSIGHT_MAPPINGS[insight.id];
  if (!mapping) return null;

  const title = `[spend-analysis] ${mapping.titlePrefix}`;

  const contextLines = [
    '## Context',
    '',
    '> Auto-generated from [claude-spend](https://github.com/shinytrap/claude-spend) spend analysis.',
    '',
    `**Insight type:** \`${insight.type}\``,
    `**Insight:** ${insight.title}`,
    '',
    insight.description,
    '',
  ];

  if (insight.action) {
    contextLines.push(`**Recommended action:** ${insight.action}`);
    contextLines.push('');
  }

  if (mapping.targetFiles.length > 0) {
    contextLines.push('**Target files:**');
    for (const f of mapping.targetFiles) {
      contextLines.push(`- \`${f}\``);
    }
    contextLines.push('');
  }

  if (mapping.linkedIssue) {
    contextLines.push(`**Related:** #${mapping.linkedIssue}`);
    contextLines.push('');
  }

  const taskLines = [
    '## Implementation Tasks',
    '',
  ];
  for (const task of mapping.tasks) {
    taskLines.push(`- [ ] \`[${task.agent}]\` **(${task.size})** ${task.desc}`);
  }
  taskLines.push('');

  const acLines = [
    '## Acceptance Criteria',
    '',
  ];
  for (const ac of mapping.acceptanceCriteria) {
    acLines.push(`- [ ] ${ac}`);
  }
  acLines.push('');

  const body = [...contextLines, ...taskLines, ...acLines].join('\n');

  return {
    title,
    body,
    labels: mapping.labels,
  };
}

module.exports = { mapInsightToIssue };

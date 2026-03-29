const assert = require('assert');
const { parseTaskSummary, computePPMTAnalysis, generatePPMTRecommendations, categorizeSession, computeSessionEfficiency, generateSessionRecommendations, computeIssueMetrics } = require('./parser');

// Test parseTaskSummary function
describe('parseTaskSummary', () => {
  test('parses task_summary from raw if present', () => {
    const raw = {
      task_summary: {
        completed: { S: 2, M: 1, L: 0 },
        failed: { S: 1, M: 0, L: 1 },
        total: 5,
        storyPointsCompleted: 7,
        storyPointsTotal: 14,
      }
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, raw.task_summary);
  });

  test('parses task descriptions for (S)/(M)/(L) markers', () => {
    const raw = {
      tasks: [
        { description: '**(S)** Task one', status: 'completed' },
        { description: '**(M)** Task two', status: 'completed' },
        { description: '**(L)** Task three', status: 'failed' },
        { description: 'Unknown size', status: 'completed' },
      ]
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 2, M: 1, L: 0 },
      failed: { S: 0, M: 0, L: 1 },
      total: 4,
      storyPointsCompleted: 1 + 3 + 1,
      storyPointsTotal: 1 + 3 + 5 + 1,
    });
  });

  test('defaults unknown sizes to S (1 point)', () => {
    const raw = {
      tasks: [
        { description: 'No size marker', status: 'completed' },
        { description: 'Another unknown', status: 'failed' },
      ]
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 1, M: 0, L: 0 },
      failed: { S: 1, M: 0, L: 0 },
      total: 2,
      storyPointsCompleted: 1,
      storyPointsTotal: 2,
    });
  });

  test('returns zeros for empty tasks array', () => {
    const raw = { tasks: [] };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 0, M: 0, L: 0 },
      failed: { S: 0, M: 0, L: 0 },
      total: 0,
      storyPointsCompleted: 0,
      storyPointsTotal: 0,
    });
  });

  test('returns zeros for missing tasks', () => {
    const raw = {};
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 0, M: 0, L: 0 },
      failed: { S: 0, M: 0, L: 0 },
      total: 0,
      storyPointsCompleted: 0,
      storyPointsTotal: 0,
    });
  });

  test('counts in_progress tasks as completed', () => {
    const raw = {
      state: 'completed',
      stages: { complete: { status: 'completed' } },
      tasks: [
        { description: '**(S)** Task one', status: 'completed' },
        { description: '**(S)** Task two', status: 'in_progress' },
      ]
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 2, M: 0, L: 0 },
      failed: { S: 0, M: 0, L: 0 },
      total: 2,
      storyPointsCompleted: 2,
      storyPointsTotal: 2,
    });
  });

  test('counts pending tasks as completed when run is completed', () => {
    const raw = {
      state: 'completed',
      stages: { complete: { status: 'completed' } },
      tasks: [
        { description: '**(M)** Task one', status: 'completed' },
        { description: '**(S)** Task two', status: 'pending' },
      ]
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 1, M: 1, L: 0 },
      failed: { S: 0, M: 0, L: 0 },
      total: 2,
      storyPointsCompleted: 1 + 3,
      storyPointsTotal: 1 + 3,
    });
  });

  test('does not count in_progress or pending tasks as completed when run is not completed', () => {
    const raw = {
      state: 'in_progress',
      stages: { complete: { status: 'in_progress' } },
      tasks: [
        { description: '**(S)** Task one', status: 'completed' },
        { description: '**(M)** Task two', status: 'in_progress' },
        { description: '**(L)** Task three', status: 'pending' },
      ]
    };
    const result = parseTaskSummary(raw);
    assert.deepStrictEqual(result, {
      completed: { S: 1, M: 0, L: 0 },
      failed: { S: 0, M: 0, L: 0 },
      total: 3,
      storyPointsCompleted: 1,
      storyPointsTotal: 1 + 3 + 5,
    });
  });
});

describe('computePPMTAnalysis', () => {
  function makeRun(overrides) {
    return {
      project: 'test-project',
      state: 'completed',
      taskCount: 3,
      escalations: [],
      date: '2026-03-01',
      taskSummary: { completed: { S: 2, M: 1, L: 0 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 5, storyPointsTotal: 5 },
      stageDurations: {},
      ...overrides,
    };
  }

  test('taskSizeCompletion: aggregates S/M/L completed and failed counts with rates', () => {
    const runs = [
      makeRun({ taskSummary: { completed: { S: 2, M: 1, L: 0 }, failed: { S: 1, M: 0, L: 1 }, storyPointsCompleted: 5, storyPointsTotal: 11 } }),
      makeRun({ taskSummary: { completed: { S: 1, M: 0, L: 1 }, failed: { S: 0, M: 1, L: 0 }, storyPointsCompleted: 6, storyPointsTotal: 9 } }),
    ];
    const { taskSizeCompletion } = computePPMTAnalysis(runs, []);
    assert.strictEqual(taskSizeCompletion.S.completed, 3);
    assert.strictEqual(taskSizeCompletion.S.failed, 1);
    assert.strictEqual(taskSizeCompletion.S.total, 4);
    assert.strictEqual(taskSizeCompletion.M.completed, 1);
    assert.strictEqual(taskSizeCompletion.M.failed, 1);
    assert.strictEqual(taskSizeCompletion.M.total, 2);
    assert.strictEqual(taskSizeCompletion.L.completed, 1);
    assert.strictEqual(taskSizeCompletion.L.failed, 1);
    assert.strictEqual(taskSizeCompletion.L.total, 2);
    assert.strictEqual(taskSizeCompletion.S.rate, 75);
  });

  test('escalationCorrelation: groups runs by escalation count bucket', () => {
    const runs = [
      makeRun({ escalations: [], state: 'completed' }),
      makeRun({ escalations: [], state: 'completed' }),
      makeRun({ escalations: [{}], state: 'error' }),
      makeRun({ escalations: [{}, {}], state: 'completed' }),
      makeRun({ escalations: [{}, {}, {}, {}], state: 'error' }),
      makeRun({ escalations: [{}, {}, {}, {}, {}, {}, {}], state: 'completed' }),
    ];
    const { escalationCorrelation } = computePPMTAnalysis(runs, []);
    assert.strictEqual(escalationCorrelation['0'].total, 2);
    assert.strictEqual(escalationCorrelation['0'].completionRate, 100);
    assert.strictEqual(escalationCorrelation['1-2'].total, 2);
    assert.strictEqual(escalationCorrelation['1-2'].completionRate, 50);
    assert.strictEqual(escalationCorrelation['3-5'].total, 1);
    assert.strictEqual(escalationCorrelation['3-5'].completionRate, 0);
    assert.strictEqual(escalationCorrelation['6+'].total, 1);
    assert.strictEqual(escalationCorrelation['6+'].completionRate, 100);
  });

  test('failureBreakdown: counts by failure type', () => {
    const runs = [
      makeRun({ state: 'completed' }),
      makeRun({ state: 'error', taskCount: 0 }),
      makeRun({ state: 'error', taskCount: 2 }),
      makeRun({ state: 'max_iterations_pr_review' }),
      makeRun({ state: 'running' }),
    ];
    const { failureBreakdown } = computePPMTAnalysis(runs, []);
    assert.strictEqual(failureBreakdown.parse_failure, 1);
    assert.strictEqual(failureBreakdown.error, 1);
    assert.strictEqual(failureBreakdown.max_iterations_pr_review, 1);
    assert.strictEqual(failureBreakdown.running, 1);
  });

  test('taskCountCorrelation: avg task count for completed vs failed', () => {
    const runs = [
      makeRun({ state: 'completed', taskCount: 4 }),
      makeRun({ state: 'completed', taskCount: 6 }),
      makeRun({ state: 'error', taskCount: 2 }),
      makeRun({ state: 'error', taskCount: 0 }),
    ];
    const { taskCountCorrelation } = computePPMTAnalysis(runs, []);
    assert.strictEqual(taskCountCorrelation.completedAvg, 5);
    assert.strictEqual(taskCountCorrelation.failedAvg, 1);
    assert.ok(Array.isArray(taskCountCorrelation.optimalRange));
  });

  test('topEscalationStages: top 5 stages by escalation count', () => {
    const runs = [
      makeRun({ escalations: [{ stage: 'implement' }, { stage: 'implement' }, { stage: 'review' }] }),
      makeRun({ escalations: [{ stage: 'implement' }, { stage: 'test' }] }),
    ];
    const { topEscalationStages } = computePPMTAnalysis(runs, []);
    assert.strictEqual(topEscalationStages[0].stage, 'implement');
    assert.strictEqual(topEscalationStages[0].count, 3);
    assert.ok(topEscalationStages.length <= 5);
  });

  test('projectYield: per-project SP yield percentages', () => {
    const runs = [
      makeRun({ project: 'proj-a', taskSummary: { completed: { S: 2, M: 0, L: 0 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 2, storyPointsTotal: 4 } }),
      makeRun({ project: 'proj-a', taskSummary: { completed: { S: 1, M: 0, L: 0 }, failed: { S: 1, M: 0, L: 0 }, storyPointsCompleted: 1, storyPointsTotal: 2 } }),
      makeRun({ project: 'proj-b', taskSummary: { completed: { S: 0, M: 1, L: 0 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 3, storyPointsTotal: 3 } }),
    ];
    const { projectYield } = computePPMTAnalysis(runs, []);
    const projA = projectYield.find(p => p.project === 'proj-a');
    assert.strictEqual(projA.spCompleted, 3);
    assert.strictEqual(projA.spTotal, 6);
    assert.strictEqual(projA.yieldPct, 50);
    const projB = projectYield.find(p => p.project === 'proj-b');
    assert.strictEqual(projB.yieldPct, 100);
  });

  test('ppmtByDay: daily PP/100MT joining run SP with pipeline session tokens', () => {
    const runs = [
      makeRun({ date: '2026-03-01', taskSummary: { completed: { S: 0, M: 0, L: 1 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 5, storyPointsTotal: 5 } }),
      makeRun({ date: '2026-03-02', taskSummary: { completed: { S: 0, M: 1, L: 0 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 3, storyPointsTotal: 3 } }),
    ];
    const dailyUsage = [
      { date: '2026-03-01', totalTokens: 1_000_000 },
      { date: '2026-03-02', totalTokens: 500_000 },
    ];
    const { ppmtByDay } = computePPMTAnalysis(runs, dailyUsage);
    // PP/100MT: SP / (tokens / 100_000_000)
    // day1: 5 / (1_000_000 / 100_000_000) = 5 / 0.01 = 500
    const day1 = ppmtByDay.find(d => d.date === '2026-03-01');
    assert.strictEqual(day1.pp100mt, 500);
    // day2: 3 / (500_000 / 100_000_000) = 3 / 0.005 = 600
    const day2 = ppmtByDay.find(d => d.date === '2026-03-02');
    assert.strictEqual(day2.pp100mt, 600);
  });

  test('handles empty runs array', () => {
    const result = computePPMTAnalysis([], []);
    assert.ok(result.taskSizeCompletion);
    assert.ok(result.escalationCorrelation);
    assert.ok(result.failureBreakdown);
    assert.ok(result.taskCountCorrelation);
    assert.ok(Array.isArray(result.topEscalationStages));
    assert.ok(Array.isArray(result.projectYield));
    assert.ok(Array.isArray(result.ppmtByDay));
  });
});

describe('generatePPMTRecommendations', () => {
  function makeAnalysis(overrides) {
    return {
      taskSizeCompletion: {
        S: { completed: 10, failed: 2, total: 12, rate: 83 },
        M: { completed: 6, failed: 4, total: 10, rate: 60 },
        L: { completed: 2, failed: 1, total: 3, rate: 67 },
      },
      escalationCorrelation: {
        '0':   { total: 4, completed: 3, completionRate: 75 },
        '1-2': { total: 3, completed: 2, completionRate: 67 },
        '3-5': { total: 2, completed: 1, completionRate: 50 },
        '6+':  { total: 1, completed: 0, completionRate: 0  },
      },
      failureBreakdown: { parse_failure: 1, error: 1, max_iterations_pr_review: 1, running: 0, other: 0 },
      taskCountCorrelation: { completedAvg: 4, failedAvg: 5, optimalRange: [4, 5] },
      topEscalationStages: [{ stage: 'implement', count: 8 }, { stage: 'review', count: 3 }],
      projectYield: [{ project: 'proj-a', spCompleted: 10, spTotal: 15, yieldPct: 67 }],
      ppmtByDay: [],
      ...overrides,
    };
  }

  test('returns empty array when fewer than 5 total runs', () => {
    const analysis = makeAnalysis({
      escalationCorrelation: {
        '0':   { total: 2, completed: 1, completionRate: 50 },
        '1-2': { total: 1, completed: 0, completionRate: 0 },
        '3-5': { total: 1, completed: 0, completionRate: 0 },
        '6+':  { total: 0, completed: 0, completionRate: 0 },
      },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.deepStrictEqual(recs, []);
  });

  test('recommendations array only includes triggered items', () => {
    // neutral analysis — no thresholds exceeded
    const recs = generatePPMTRecommendations(makeAnalysis());
    assert.ok(Array.isArray(recs));
  });

  test('each recommendation has required fields', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 3, error: 0, max_iterations_pr_review: 0, running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(recs.length > 0, 'expected at least one recommendation');
    for (const rec of recs) {
      assert.ok(typeof rec.id === 'string', 'missing id');
      assert.ok(typeof rec.priority === 'number', 'missing priority');
      assert.ok(typeof rec.ppmt_impact === 'number', 'missing ppmt_impact');
      assert.ok(typeof rec.title === 'string', 'missing title');
      assert.ok(typeof rec.detail === 'string', 'missing detail');
      assert.ok(rec.evidence !== undefined, 'missing evidence');
      assert.ok(typeof rec.action === 'string', 'missing action');
    }
  });

  test('recommendations are sorted by priority ascending (1=highest)', () => {
    const analysis = makeAnalysis({
      taskSizeCompletion: {
        S: { completed: 10, failed: 0, total: 10, rate: 100 },
        M: { completed: 3, failed: 7, total: 10, rate: 30 },
        L: { completed: 2, failed: 1, total: 3, rate: 67 },
      },
      failureBreakdown: { parse_failure: 4, error: 0, max_iterations_pr_review: 3, running: 0, other: 0 },
      topEscalationStages: [{ stage: 'deploy', count: 12 }],
    });
    const recs = generatePPMTRecommendations(analysis);
    for (let i = 1; i < recs.length; i++) {
      assert.ok(recs[i].priority >= recs[i - 1].priority, 'recommendations not sorted by priority');
    }
  });

  test('(a) generates M-task splitting rec when M rate is 16+ points below S rate', () => {
    const analysis = makeAnalysis({
      taskSizeCompletion: {
        S: { completed: 8, failed: 2, total: 10, rate: 80 },
        M: { completed: 3, failed: 7, total: 10, rate: 30 },
        L: { completed: 2, failed: 1, total: 3, rate: 67 },
      },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'm_task_splitting');
    assert.ok(rec, 'expected m_task_splitting recommendation');
    assert.ok(rec.detail.includes('30%') || rec.detail.includes('30'), 'detail should mention M rate');
    assert.ok(rec.detail.includes('80%') || rec.detail.includes('80'), 'detail should mention S rate');
  });

  test('(a) does NOT generate M-task splitting rec when gap is <=15 points', () => {
    const analysis = makeAnalysis({
      taskSizeCompletion: {
        S: { completed: 8, failed: 2, total: 10, rate: 80 },
        M: { completed: 6, failed: 4, total: 10, rate: 65 },
        L: { completed: 2, failed: 1, total: 3, rate: 67 },
      },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'm_task_splitting'), 'should not generate rec for 15-point gap');
  });

  test('(b) generates parse failure rec when >2 parse failures exist', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 3, error: 0, max_iterations_pr_review: 0, running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'parse_failures');
    assert.ok(rec, 'expected parse_failures recommendation');
    assert.ok(rec.detail.includes('3'), 'detail should mention count');
    assert.ok(rec.evidence.parse_failure === 3, 'evidence should include parse_failure count');
  });

  test('(b) does NOT generate parse failure rec when <=2 parse failures', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 2, error: 0, max_iterations_pr_review: 0, running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'parse_failures'), 'should not trigger for <=2 parse failures');
  });

  test('(c) generates task count reduction rec when failedAvg > completedAvg + 1.5', () => {
    const analysis = makeAnalysis({
      taskCountCorrelation: { completedAvg: 3, failedAvg: 6, optimalRange: [2, 3] },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'task_count_reduction');
    assert.ok(rec, 'expected task_count_reduction recommendation');
    assert.ok(rec.detail.includes('6') || rec.detail.includes('3'), 'detail should include avg counts');
  });

  test('(c) does NOT generate task count reduction rec when difference <=1.5', () => {
    const analysis = makeAnalysis({
      taskCountCorrelation: { completedAvg: 4, failedAvg: 5, optimalRange: [4, 5] },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'task_count_reduction'), 'should not trigger for <=1.5 difference');
  });

  test('(d) generates PR review loop rec when >2 max_iterations_pr_review runs', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 0, error: 0, max_iterations_pr_review: 3, running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'pr_review_loop');
    assert.ok(rec, 'expected pr_review_loop recommendation');
    assert.ok(rec.detail.includes('3'), 'detail should mention count');
  });

  test('(d) does NOT generate PR review loop rec when <=2 occurrences', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 0, error: 0, max_iterations_pr_review: 2, running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'pr_review_loop'), 'should not trigger for <=2');
  });

  test('(e) generates max_turns_exhausted rec when top stage has >10 escalations', () => {
    const analysis = makeAnalysis({
      topEscalationStages: [{ stage: 'implement', count: 11 }, { stage: 'review', count: 3 }],
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'max_turns_exhausted');
    assert.ok(rec, 'expected max_turns_exhausted recommendation');
    assert.ok(rec.detail.includes('implement'), 'detail should cite stage name');
    assert.ok(rec.detail.includes('11'), 'detail should include count');
  });

  test('(e) does NOT generate max_turns_exhausted rec when top stage has <=10 escalations', () => {
    const analysis = makeAnalysis({
      topEscalationStages: [{ stage: 'implement', count: 10 }],
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'max_turns_exhausted'), 'should not trigger for <=10');
  });

  test('(f) generates project yield rec when any project has yield <20%', () => {
    const analysis = makeAnalysis({
      projectYield: [
        { project: 'proj-a', spCompleted: 10, spTotal: 15, yieldPct: 67 },
        { project: 'proj-b', spCompleted: 1, spTotal: 10, yieldPct: 10 },
      ],
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'project_yield_proj-b');
    assert.ok(rec, 'expected project_yield rec for proj-b');
    assert.ok(rec.detail.includes('proj-b'), 'detail should cite project name');
    assert.ok(rec.detail.includes('10%') || rec.detail.includes('10'), 'detail should cite yield %');
  });

  test('(f) does NOT generate project yield rec when all projects are >=20%', () => {
    const analysis = makeAnalysis({
      projectYield: [
        { project: 'proj-a', spCompleted: 5, spTotal: 10, yieldPct: 50 },
        { project: 'proj-b', spCompleted: 4, spTotal: 15, yieldPct: 27 },
      ],
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id && r.id.startsWith('project_yield_')), 'should not trigger when all >=20%');
  });

  test('(g) generates 0-escalation failure rec when >30% of failures have 0 escalations', () => {
    // 0-bucket: 3 total, 0 completed = 3 failures
    // 1-2 bucket: 2 total, 2 completed = 0 failures
    // total failures = 3, 0-escalation failures = 3 → 100% > 30%
    const analysis = makeAnalysis({
      escalationCorrelation: {
        '0':   { total: 3, completed: 0, completionRate: 0 },
        '1-2': { total: 2, completed: 2, completionRate: 100 },
        '3-5': { total: 0, completed: 0, completionRate: 0 },
        '6+':  { total: 0, completed: 0, completionRate: 0 },
      },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'zero_escalation_failures');
    assert.ok(rec, 'expected zero_escalation_failures recommendation');
    assert.ok(rec.evidence.zeroEscalationFailures === 3, 'evidence should include failure count');
  });

  test('(g) does NOT generate 0-escalation failure rec when <=30% of failures have 0 escalations', () => {
    // 0-bucket: 10 total, 8 completed = 2 failures
    // 1-2 bucket: 5 total, 0 completed = 5 failures, plus others = 10 total failures, 2/10 = 20% < 30%
    const analysis = makeAnalysis({
      escalationCorrelation: {
        '0':   { total: 10, completed: 8, completionRate: 80 },
        '1-2': { total: 5, completed: 0, completionRate: 0 },
        '3-5': { total: 3, completed: 0, completionRate: 0 },
        '6+':  { total: 2, completed: 0, completionRate: 0 },
      },
    });
    const recs = generatePPMTRecommendations(analysis);
    assert.ok(!recs.find(r => r.id === 'zero_escalation_failures'), 'should not trigger when <=30%');
  });

  test('(h) generates high_mt_per_issue when mtPerIssue > 50', () => {
    const issueMetrics = { mtPerIssue: 75, issuesAddressed: 4, issueMeta: [] };
    const recs = generatePPMTRecommendations(makeAnalysis(), issueMetrics);
    const rec = recs.find(r => r.id === 'high_mt_per_issue');
    assert.ok(rec, 'expected high_mt_per_issue recommendation');
    assert.strictEqual(rec.priority, 2);
    assert.ok(rec.ppmt_impact > 0, 'ppmt_impact should be positive');
    assert.ok(rec.evidence.mtPerIssue === 75);
    assert.ok(rec.evidence.issuesAddressed === 4);
  });

  test('(h) does NOT generate high_mt_per_issue when mtPerIssue <= 50', () => {
    const issueMetrics = { mtPerIssue: 50, issuesAddressed: 3, issueMeta: [] };
    const recs = generatePPMTRecommendations(makeAnalysis(), issueMetrics);
    assert.ok(!recs.find(r => r.id === 'high_mt_per_issue'), 'should not trigger when mtPerIssue <= 50');
  });

  test('(h) does NOT generate high_mt_per_issue when issueMetrics is null', () => {
    const recs = generatePPMTRecommendations(makeAnalysis(), null);
    assert.ok(!recs.find(r => r.id === 'high_mt_per_issue'), 'should not trigger without issueMetrics');
  });

  test('(i) generates rising_mt_per_issue when recent 2w avg > prior 2w avg by >25%', () => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const threeWeeksAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
    const issueMetrics = {
      mtPerIssue: 40,
      issuesAddressed: 4,
      issueMeta: [
        { closedAt: oneWeekAgo.toISOString(), mtUsed: 80 },
        { closedAt: oneWeekAgo.toISOString(), mtUsed: 80 },
        { closedAt: threeWeeksAgo.toISOString(), mtUsed: 40 },
        { closedAt: threeWeeksAgo.toISOString(), mtUsed: 40 },
      ],
    };
    const recs = generatePPMTRecommendations(makeAnalysis(), issueMetrics);
    const rec = recs.find(r => r.id === 'rising_mt_per_issue');
    assert.ok(rec, 'expected rising_mt_per_issue recommendation');
    assert.strictEqual(rec.priority, 2);
    assert.ok(rec.evidence.pctIncrease === 100, `expected 100% increase, got ${rec.evidence.pctIncrease}`);
  });

  test('(i) does NOT generate rising_mt_per_issue when increase <= 25%', () => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const threeWeeksAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
    const issueMetrics = {
      mtPerIssue: 40,
      issuesAddressed: 4,
      issueMeta: [
        { closedAt: oneWeekAgo.toISOString(), mtUsed: 50 },
        { closedAt: threeWeeksAgo.toISOString(), mtUsed: 40 },
      ],
    };
    const recs = generatePPMTRecommendations(makeAnalysis(), issueMetrics);
    assert.ok(!recs.find(r => r.id === 'rising_mt_per_issue'), 'should not trigger when increase <= 25%');
  });

  test('(i) does NOT generate rising_mt_per_issue when no recent or prior issues exist', () => {
    const now = new Date();
    const sixWeeksAgo = new Date(now.getTime() - 42 * 24 * 60 * 60 * 1000);
    const issueMetrics = {
      mtPerIssue: 60,
      issuesAddressed: 2,
      issueMeta: [
        { closedAt: sixWeeksAgo.toISOString(), mtUsed: 80 },
      ],
    };
    const recs = generatePPMTRecommendations(makeAnalysis(), issueMetrics);
    assert.ok(!recs.find(r => r.id === 'rising_mt_per_issue'), 'should not trigger without data in both windows');
  });
});

describe('categorizeSession', () => {
  test('classifies session with queryCount <= 50 and pipeline prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 10,
      firstPrompt: 'Implement task 1 on branch wt-task-1 in the current working directory',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies session with queryCount > 50 and pipeline prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 51,
      firstPrompt: 'Implement task 1 on branch wt-task-1',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies session without structured prompt as interactive', () => {
    const session = {
      queryCount: 10,
      firstPrompt: 'What is the weather today?',
    };
    assert.strictEqual(categorizeSession(session), 'interactive');
  });

  test('classifies session with task size marker as pipeline_subagent', () => {
    const session = {
      queryCount: 30,
      firstPrompt: '**(S)** Implement the user login feature',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies session with exactly 50 queries and pipeline prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 50,
      firstPrompt: 'Implement task 3 on branch wt-task-3',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies session with null firstPrompt as interactive', () => {
    const session = {
      queryCount: 5,
      firstPrompt: null,
    };
    assert.strictEqual(categorizeSession(session), 'interactive');
  });

  test('classifies "Address PR review feedback" as pipeline_subagent', () => {
    const session = {
      queryCount: 46,
      firstPrompt: 'Address PR review feedback on branch feature/issue-679 in the current working directory',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies "Simplify modified TypeScript" as pipeline_subagent (AC1: tests at queryCount=93)', () => {
    const session = {
      queryCount: 93,
      firstPrompt: 'Simplify modified TypeScript/React files in the current branch',
    };
    // AC1: Partial-pattern prompts must classify as pipeline_subagent even at queryCount > 50
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies "on branch feature/issue-" as pipeline_subagent', () => {
    const session = {
      queryCount: 46,
      firstPrompt: 'Implement task 7 on branch feature/issue-938 in the current working directory',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies long pipeline session (queryCount=90) with pipeline prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 90,
      firstPrompt: 'Implement task 3 on branch wt-task-3 in the current working directory',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies session with "## Project Patterns" prefix as pipeline_subagent', () => {
    const session = {
      queryCount: 30,
      firstPrompt: '## Project Patterns are important for API design',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies simplify session with queryCount=93 as pipeline_subagent', () => {
    const session = {
      queryCount: 93,
      firstPrompt: 'Simplify modified TypeScript/React files in the current branch on branch wt-i1038-t1',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies completion-summary prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 5,
      firstPrompt: 'Generate a completion summary for PR #56 on branch feature/issue-55',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies PR-review prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 8,
      firstPrompt: 'Review PR #54 for issue #52 against base main',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies create-merge-request prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 6,
      firstPrompt: 'Create a merge request for issue #42',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });

  test('classifies create-pull-request prompt as pipeline_subagent', () => {
    const session = {
      queryCount: 7,
      firstPrompt: 'Create a pull request for issue #99',
    };
    assert.strictEqual(categorizeSession(session), 'pipeline_subagent');
  });
});

describe('computeSessionEfficiency', () => {
  function makeSession(overrides) {
    return {
      sessionId: 'test-session',
      project: 'test-project',
      date: '2026-03-01',
      firstPrompt: 'Hello world',
      totalTokens: 10000,
      queryCount: 5,
      queries: [
        { inputTokens: 500, outputTokens: 500, totalTokens: 1000, userPrompt: 'hello', model: 'sonnet' },
        { inputTokens: 600, outputTokens: 600, totalTokens: 1200, userPrompt: 'world', model: 'sonnet' },
      ],
      sessionType: 'interactive',
      ...overrides,
    };
  }

  test('splits sessions into pipeline and interactive categories', () => {
    const sessions = [
      makeSession({ sessionType: 'pipeline_subagent', totalTokens: 5000 }),
      makeSession({ sessionType: 'pipeline_subagent', totalTokens: 3000 }),
      makeSession({ sessionType: 'interactive', totalTokens: 2000 }),
    ];
    const result = computeSessionEfficiency(sessions);
    assert.strictEqual(result.pipeline.sessions, 2);
    assert.strictEqual(result.pipeline.tokens, 8000);
    assert.strictEqual(result.interactive.sessions, 1);
    assert.strictEqual(result.interactive.tokens, 2000);
    assert.strictEqual(result.pipelinePct, 80);
    assert.strictEqual(result.interactivePct, 20);
  });

  test('identifies marathon sessions (100+ queries) sorted by tokens desc', () => {
    const sessions = [
      makeSession({ queryCount: 150, totalTokens: 50000, date: '2026-03-01', firstPrompt: 'Big session' }),
      makeSession({ queryCount: 200, totalTokens: 80000, date: '2026-03-02', firstPrompt: 'Bigger session' }),
      makeSession({ queryCount: 10, totalTokens: 1000 }),
    ];
    const result = computeSessionEfficiency(sessions);
    assert.strictEqual(result.marathonSessions.length, 2);
    assert.strictEqual(result.marathonSessions[0].totalTokens, 80000);
    assert.strictEqual(result.marathonSessions[1].totalTokens, 50000);
  });

  test('counts implementation-like prompts outside pipeline', () => {
    const sessions = [
      makeSession({ sessionType: 'interactive', firstPrompt: 'fix the login bug', totalTokens: 5000 }),
      makeSession({ sessionType: 'interactive', firstPrompt: 'add user endpoint', totalTokens: 3000 }),
      makeSession({ sessionType: 'interactive', firstPrompt: 'What is the weather?', totalTokens: 1000 }),
      makeSession({ sessionType: 'pipeline_subagent', firstPrompt: 'create the feature', totalTokens: 2000 }),
    ];
    const result = computeSessionEfficiency(sessions);
    assert.strictEqual(result.implementationOutsidePipeline.count, 2);
    assert.strictEqual(result.implementationOutsidePipeline.totalTokens, 8000);
  });

  test('computes context balloon curve with correct buckets', () => {
    // Session with 12 queries to cover first two buckets
    const queries = [];
    for (let i = 0; i < 12; i++) {
      queries.push({ inputTokens: 100, outputTokens: 100, totalTokens: (i + 1) * 100, userPrompt: `q${i}`, model: 'sonnet' });
    }
    const sessions = [makeSession({ queries, queryCount: 12 })];
    const result = computeSessionEfficiency(sessions);
    assert.strictEqual(result.contextBalloonCurve.length, 4);
    assert.strictEqual(result.contextBalloonCurve[0].bucket, '1-10');
    assert.strictEqual(result.contextBalloonCurve[1].bucket, '11-50');
    // Bucket 1-10: queries 1-10 with tokens 100,200,...,1000 => avg 550
    assert.strictEqual(result.contextBalloonCurve[0].avgTokensPerQuery, 550);
    // Bucket 11-50: queries 11-12 with tokens 1100,1200 => avg 1150
    assert.strictEqual(result.contextBalloonCurve[1].avgTokensPerQuery, 1150);
  });

  test('handles empty sessions array', () => {
    const result = computeSessionEfficiency([]);
    assert.strictEqual(result.pipeline.sessions, 0);
    assert.strictEqual(result.interactive.sessions, 0);
    assert.strictEqual(result.pipelinePct, 0);
    assert.strictEqual(result.marathonSessions.length, 0);
    assert.strictEqual(result.implementationOutsidePipeline.count, 0);
    assert.strictEqual(result.contextBalloonCurve.length, 4);
  });
});

describe('generateSessionRecommendations', () => {
  function makeEfficiency(overrides) {
    return {
      pipeline: { sessions: 10, tokens: 50000 },
      interactive: { sessions: 5, tokens: 30000 },
      pipelinePct: 63,
      interactivePct: 37,
      marathonSessions: [],
      implementationOutsidePipeline: { count: 2, totalTokens: 5000 },
      contextBalloonCurve: [
        { bucket: '1-10', avgTokensPerQuery: 1000 },
        { bucket: '11-50', avgTokensPerQuery: 2000 },
        { bucket: '51-100', avgTokensPerQuery: 3000 },
        { bucket: '100+', avgTokensPerQuery: 5000 },
      ],
      modelStats: {},
      lengthBuckets: { short: { count: 0, tokens: 0 }, medium: { count: 0, tokens: 0 }, long: { count: 0, tokens: 0 } },
      ...overrides,
    };
  }

  test('(a) generates marathon session rec when session has > 200 queries', () => {
    const eff = makeEfficiency({
      marathonSessions: [
        { date: '2026-03-01', firstPrompt: 'Fix all the things in the entire codebase right now', totalTokens: 100000, queryCount: 250 },
      ],
    });
    const recs = generateSessionRecommendations(eff);
    const rec = recs.find(r => r.id === 'marathon_sessions');
    assert.ok(rec, 'expected marathon_sessions recommendation');
    assert.ok(rec.title.includes('200'), 'title should mention 200 queries threshold');
  });

  test('(a) does NOT generate marathon rec when all sessions have <= 200 queries', () => {
    const eff = makeEfficiency({
      marathonSessions: [
        { date: '2026-03-01', firstPrompt: 'Something', totalTokens: 50000, queryCount: 150 },
      ],
    });
    const recs = generateSessionRecommendations(eff);
    assert.ok(!recs.find(r => r.id === 'marathon_sessions'), 'should not trigger for <= 200 queries');
  });

  test('(b) generates session length rec when 50+ sessions dominate', () => {
    const eff = makeEfficiency({
      interactive: { sessions: 100, tokens: 1000000 },
      lengthBuckets: {
        short: { count: 50, tokens: 100000 },
        medium: { count: 20, tokens: 100000 },
        long: { count: 30, tokens: 800000 },
      },
    });
    const recs = generateSessionRecommendations(eff);
    const rec = recs.find(r => r.id === 'session_length');
    assert.ok(rec, 'expected session_length recommendation');
    assert.ok(rec.title.includes('50+'), 'title should mention 50+ query sessions');
  });

  test('(b) does NOT generate session length rec when long sessions are < 50% of tokens', () => {
    const eff = makeEfficiency({
      interactive: { sessions: 100, tokens: 1000000 },
      lengthBuckets: {
        short: { count: 80, tokens: 600000 },
        medium: { count: 10, tokens: 300000 },
        long: { count: 10, tokens: 100000 },
      },
    });
    const recs = generateSessionRecommendations(eff);
    assert.ok(!recs.find(r => r.id === 'session_length'), 'should not trigger when long < 50%');
  });

  test('(c) generates model cost rec when opus costs >1.5x more than sonnet', () => {
    const eff = makeEfficiency({
      modelStats: {
        opus: { sessions: 10, tokens: 100000, queries: 50, avgTokensPerQuery: 2000, avgTokensPerSession: 10000, avgQueriesPerSession: 5 },
        sonnet: { sessions: 20, tokens: 50000, queries: 100, avgTokensPerQuery: 500, avgTokensPerSession: 2500, avgQueriesPerSession: 5 },
      },
    });
    const recs = generateSessionRecommendations(eff);
    const rec = recs.find(r => r.id === 'model_cost');
    assert.ok(rec, 'expected model_cost recommendation');
    assert.ok(rec.title.includes('Opus'), 'title should mention Opus');
  });

  test('(d) generates context balloon rec when 100+ avg exceeds 2x of 1-10 avg', () => {
    const eff = makeEfficiency({
      contextBalloonCurve: [
        { bucket: '1-10', avgTokensPerQuery: 1000 },
        { bucket: '11-50', avgTokensPerQuery: 2000 },
        { bucket: '51-100', avgTokensPerQuery: 3000 },
        { bucket: '100+', avgTokensPerQuery: 3000 },
      ],
    });
    const recs = generateSessionRecommendations(eff);
    const rec = recs.find(r => r.id === 'context_balloon');
    assert.ok(rec, 'expected context_balloon recommendation');
  });

  test('(d) does NOT generate context balloon rec when ratio <= 2x', () => {
    const eff = makeEfficiency({
      contextBalloonCurve: [
        { bucket: '1-10', avgTokensPerQuery: 1000 },
        { bucket: '11-50', avgTokensPerQuery: 1500 },
        { bucket: '51-100', avgTokensPerQuery: 1800 },
        { bucket: '100+', avgTokensPerQuery: 1900 },
      ],
    });
    const recs = generateSessionRecommendations(eff);
    assert.ok(!recs.find(r => r.id === 'context_balloon'), 'should not trigger for <= 2x');
  });

  test('returns empty array when no thresholds are exceeded', () => {
    const recs = generateSessionRecommendations(makeEfficiency());
    assert.ok(Array.isArray(recs));
  });
});

describe('computeIssueMetrics', () => {
  test('returns zero fields when runs is empty', () => {
    const result = computeIssueMetrics([], []);
    assert.strictEqual(result.issuesAddressed, 0);
    assert.strictEqual(result.mtPerIssue, 0);
    assert.strictEqual(result.avgImplementHours, 0);
    assert.deepStrictEqual(result.issueMeta, []);
  });

  test('counts unique issues across runs (deduplicates same project+issue)', () => {
    const runs = [
      { project: 'owner/repo', issue: 42, date: '2025-01-01', logType: 'implement-issue' },
      { project: 'owner/repo', issue: 42, date: '2025-01-02', logType: 'implement-issue' }, // duplicate
      { project: 'owner/repo', issue: 43, date: '2025-01-01', logType: 'implement-issue' },
    ];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.issuesAddressed, 2);
    assert.strictEqual(result.issueMeta.length, 2);
  });

  test('issueMeta contains number and repo for each unique issue', () => {
    const runs = [
      { project: 'owner/repo', issue: 7, date: '2025-01-01', logType: 'implement-issue' },
    ];
    const result = computeIssueMetrics(runs, []);
    assert.deepStrictEqual(result.issueMeta, [{ number: 7, repo: 'owner/repo' }]);
  });

  test('runs without issue field do not contribute to issuesAddressed', () => {
    const runs = [
      { project: 'owner/repo', date: '2025-01-01', logType: 'implement-issue' }, // no issue
      { project: 'owner/repo', issue: null, date: '2025-01-02', logType: 'implement-issue' }, // null issue
    ];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.issuesAddressed, 0);
    assert.deepStrictEqual(result.issueMeta, []);
  });

  test('computes mtPerIssue using pipelineDailyUsage tokens matching run dates', () => {
    const runs = [
      { project: 'owner/repo', issue: 1, date: '2025-01-01', logType: 'implement-issue' },
      { project: 'owner/repo', issue: 2, date: '2025-01-02', logType: 'implement-issue' },
    ];
    const pipelineDailyUsage = [
      { date: '2025-01-01', totalTokens: 1_000_000 },
      { date: '2025-01-02', totalTokens: 1_000_000 },
      { date: '2025-01-03', totalTokens: 9_000_000 }, // not a run date, excluded
    ];
    const result = computeIssueMetrics(runs, pipelineDailyUsage);
    // 2_000_000 tokens / 1_000_000 / 2 issues = 1.00 MT/issue
    assert.strictEqual(result.mtPerIssue, 1.0);
  });

  test('mtPerIssue is 0 when pipelineDailyUsage is empty', () => {
    const runs = [{ project: 'owner/repo', issue: 1, date: '2025-01-01', logType: 'implement-issue' }];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.mtPerIssue, 0);
  });

  test('mtPerIssue is 0 when there are no issues (avoids divide-by-zero)', () => {
    const runs = [{ project: 'owner/repo', date: '2025-01-01', logType: 'implement-issue' }];
    const pipelineDailyUsage = [{ date: '2025-01-01', totalTokens: 5_000_000 }];
    const result = computeIssueMetrics(runs, pipelineDailyUsage);
    assert.strictEqual(result.mtPerIssue, 0);
  });

  test('computes avgImplementHours from stageDurations.implement (in seconds)', () => {
    const runs = [
      { project: 'owner/repo', issue: 1, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 3600 } },   // 1 hour
      { project: 'owner/repo', issue: 2, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 7200 } },   // 2 hours
    ];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.avgImplementHours, 1.5);
  });

  test('avgImplementHours is 0 when no runs have stageDurations.implement', () => {
    const runs = [
      { project: 'owner/repo', issue: 1, date: '2025-01-01', logType: 'implement-issue' }, // no stageDurations
      { project: 'owner/repo', issue: 2, date: '2025-01-01', logType: 'implement-issue', stageDurations: {} }, // missing implement
    ];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.avgImplementHours, 0);
  });

  test('runs without date field are excluded from pipeline token matching', () => {
    const runs = [
      { project: 'owner/repo', issue: 1, logType: 'implement-issue' }, // no date
    ];
    const pipelineDailyUsage = [{ date: '2025-01-01', totalTokens: 5_000_000 }];
    const result = computeIssueMetrics(runs, pipelineDailyUsage);
    assert.strictEqual(result.mtPerIssue, 0); // no matching dates
  });

  test('includes stageDurations.implement of 0 in avgImplementHours (falsy but valid)', () => {
    const runs = [
      { project: 'r', issue: 1, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 0 } },
      { project: 'r', issue: 2, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 7200 } }, // 2 hours
    ];
    const result = computeIssueMetrics(runs, []);
    assert.strictEqual(result.avgImplementHours, 1); // (0 + 2) / 2
  });

  test('aggregates pipeline tokens across multiple runs sharing the same date', () => {
    const runs = [
      { project: 'owner/repo', issue: 1, date: '2025-01-01', logType: 'implement-issue' },
      { project: 'owner/repo', issue: 2, date: '2025-01-01', logType: 'implement-issue' }, // same date as above
    ];
    const pipelineDailyUsage = [
      { date: '2025-01-01', totalTokens: 4_000_000 },
    ];
    const result = computeIssueMetrics(runs, pipelineDailyUsage);
    // 4_000_000 / 1_000_000 / 2 issues = 2.0
    assert.strictEqual(result.mtPerIssue, 2.0);
  });

  test('rounds mtPerIssue and avgImplementHours to 2 decimal places', () => {
    const runs = [
      { project: 'r', issue: 1, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 3601 } }, // 1.000277... hours
      { project: 'r', issue: 2, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 3601 } },
      { project: 'r', issue: 3, date: '2025-01-01', logType: 'implement-issue', stageDurations: { implement: 3601 } },
    ];
    const pipelineDailyUsage = [{ date: '2025-01-01', totalTokens: 1_000_001 }];
    const result = computeIssueMetrics(runs, pipelineDailyUsage);
    assert.ok(Number.isFinite(result.mtPerIssue));
    assert.ok(Number.isFinite(result.avgImplementHours));
    // verify only 2 decimal places
    assert.strictEqual(result.mtPerIssue, Math.round(result.mtPerIssue * 100) / 100);
    assert.strictEqual(result.avgImplementHours, Math.round(result.avgImplementHours * 100) / 100);
  });
});


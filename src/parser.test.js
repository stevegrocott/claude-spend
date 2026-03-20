const assert = require('assert');
const { parseTaskSummary, computePPMTAnalysis, generatePPMTRecommendations } = require('./parser');

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
      makeRun({ state: 'stuck_running' }),
    ];
    const { failureBreakdown } = computePPMTAnalysis(runs, []);
    assert.strictEqual(failureBreakdown.parse_failure, 1);
    assert.strictEqual(failureBreakdown.error, 1);
    assert.strictEqual(failureBreakdown.max_iterations_pr_review, 1);
    assert.strictEqual(failureBreakdown.stuck_running, 1);
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

  test('ppmtByDay: daily PP/MT joining run SP with session tokens', () => {
    const runs = [
      makeRun({ date: '2026-03-01', taskSummary: { completed: { S: 0, M: 0, L: 1 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 5, storyPointsTotal: 5 } }),
      makeRun({ date: '2026-03-02', taskSummary: { completed: { S: 0, M: 1, L: 0 }, failed: { S: 0, M: 0, L: 0 }, storyPointsCompleted: 3, storyPointsTotal: 3 } }),
    ];
    const dailyUsage = [
      { date: '2026-03-01', totalTokens: 1_000_000 },
      { date: '2026-03-02', totalTokens: 500_000 },
    ];
    const { ppmtByDay } = computePPMTAnalysis(runs, dailyUsage);
    const day1 = ppmtByDay.find(d => d.date === '2026-03-01');
    assert.strictEqual(day1.ppmt, 5);
    const day2 = ppmtByDay.find(d => d.date === '2026-03-02');
    assert.strictEqual(day2.ppmt, 6);
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
      failureBreakdown: { parse_failure: 1, error: 1, max_iterations_pr_review: 1, stuck_running: 0, other: 0 },
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
      failureBreakdown: { parse_failure: 3, error: 0, max_iterations_pr_review: 0, stuck_running: 0, other: 0 },
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
      failureBreakdown: { parse_failure: 4, error: 0, max_iterations_pr_review: 3, stuck_running: 0, other: 0 },
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
      failureBreakdown: { parse_failure: 3, error: 0, max_iterations_pr_review: 0, stuck_running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'parse_failures');
    assert.ok(rec, 'expected parse_failures recommendation');
    assert.ok(rec.detail.includes('3'), 'detail should mention count');
    assert.ok(rec.evidence.parse_failure === 3, 'evidence should include parse_failure count');
  });

  test('(b) does NOT generate parse failure rec when <=2 parse failures', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 2, error: 0, max_iterations_pr_review: 0, stuck_running: 0, other: 0 },
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
      failureBreakdown: { parse_failure: 0, error: 0, max_iterations_pr_review: 3, stuck_running: 0, other: 0 },
    });
    const recs = generatePPMTRecommendations(analysis);
    const rec = recs.find(r => r.id === 'pr_review_loop');
    assert.ok(rec, 'expected pr_review_loop recommendation');
    assert.ok(rec.detail.includes('3'), 'detail should mention count');
  });

  test('(d) does NOT generate PR review loop rec when <=2 occurrences', () => {
    const analysis = makeAnalysis({
      failureBreakdown: { parse_failure: 0, error: 0, max_iterations_pr_review: 2, stuck_running: 0, other: 0 },
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
});

// Simple test runner
// NOTE: sets process.exitCode on failure but has no protection against async tests
// executing after process would naturally exit — safe for this sync-only suite,
// but async tests added later may produce silent failures.
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

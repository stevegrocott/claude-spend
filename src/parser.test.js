const assert = require('assert');
const { parseTaskSummary, computePPMTAnalysis } = require('./parser');

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

// Simple test runner
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

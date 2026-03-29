const assert = require('assert');
const { enrichIssueCycleTime } = require('./server');

// Helper to build a minimal issueMetrics object
function makeIssueMetrics(overrides = {}) {
  return {
    issuesAddressed: 1,
    mtPerIssue: 0,
    avgImplementHours: 0,
    issueMeta: [{ repo: 'owner/repo', number: 1 }],
    ...overrides,
  };
}

// Helper execFn that returns a closed issue response
function makeExecFn(createdAt, closedAt) {
  return () => JSON.stringify({ createdAt, closedAt });
}

describe('enrichIssueCycleTime', () => {
  test('returns issueMetrics unchanged when issueMeta is empty', () => {
    const metrics = makeIssueMetrics({ issueMeta: [] });
    const result = enrichIssueCycleTime(metrics, {});
    assert.strictEqual(result, metrics); // same reference — no enrichment needed
  });

  test('returns issueMetrics unchanged when issueMetrics is null', () => {
    const result = enrichIssueCycleTime(null, {});
    assert.strictEqual(result, null);
  });

  test('returns issueMetrics unchanged when issueMetrics is undefined', () => {
    const result = enrichIssueCycleTime(undefined, {});
    assert.strictEqual(result, undefined);
  });

  test('computes avgCycleTimeDays from createdAt and closedAt', () => {
    const execFn = makeExecFn('2025-01-01T00:00:00Z', '2025-01-11T00:00:00Z');
    const result = enrichIssueCycleTime(makeIssueMetrics(), {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 10);
  });

  test('sets cycleTimeDays on individual issueMeta entries', () => {
    const execFn = makeExecFn('2025-01-01T00:00:00Z', '2025-01-06T00:00:00Z');
    const metrics = makeIssueMetrics();
    const result = enrichIssueCycleTime(metrics, {}, execFn);
    assert.strictEqual(result.issueMeta[0].cycleTimeDays, 5);
  });

  test('avgCycleTimeDays is 0 when gh CLI throws (unavailable)', () => {
    const execFn = () => { throw new Error('gh not found'); };
    const result = enrichIssueCycleTime(makeIssueMetrics(), {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 0);
  });

  test('avgCycleTimeDays is 0 when issue is not closed (no closedAt)', () => {
    const execFn = () => JSON.stringify({ createdAt: '2025-01-01T00:00:00Z', closedAt: null });
    const result = enrichIssueCycleTime(makeIssueMetrics(), {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 0);
  });

  test('avgCycleTimeDays is 0 when all issues are open', () => {
    const execFn = () => JSON.stringify({ createdAt: '2025-01-01T00:00:00Z' }); // no closedAt
    const metrics = makeIssueMetrics({
      issueMeta: [
        { repo: 'owner/repo', number: 1 },
        { repo: 'owner/repo', number: 2 },
      ],
    });
    const result = enrichIssueCycleTime(metrics, {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 0);
  });

  test('averages cycle times across multiple issues', () => {
    let call = 0;
    const responses = [
      JSON.stringify({ createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-11T00:00:00Z' }), // 10 days
      JSON.stringify({ createdAt: '2025-01-01T00:00:00Z', closedAt: '2025-01-21T00:00:00Z' }), // 20 days
    ];
    const execFn = () => responses[call++];
    const metrics = makeIssueMetrics({
      issueMeta: [
        { repo: 'owner/repo', number: 1 },
        { repo: 'owner/repo', number: 2 },
      ],
    });
    const result = enrichIssueCycleTime(metrics, {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 15);
  });

  test('uses cache to avoid calling execFn again for same issue', () => {
    const cache = { 'owner/repo/1': 7 };
    let called = false;
    const execFn = () => { called = true; return JSON.stringify({}); };
    const result = enrichIssueCycleTime(makeIssueMetrics(), cache, execFn);
    assert.strictEqual(called, false, 'execFn should not be called when cache hit');
    assert.strictEqual(result.avgCycleTimeDays, 7);
  });

  test('skips issue from avg when cached value is null (previously failed/open)', () => {
    const cache = { 'owner/repo/1': null };
    const execFn = () => { throw new Error('should not be called'); };
    const result = enrichIssueCycleTime(makeIssueMetrics(), cache, execFn);
    assert.strictEqual(result.avgCycleTimeDays, 0);
    assert.strictEqual(result.issueMeta[0].cycleTimeDays, undefined);
  });

  test('caches null for issues where gh CLI fails', () => {
    const cache = {};
    const execFn = () => { throw new Error('gh not found'); };
    enrichIssueCycleTime(makeIssueMetrics(), cache, execFn);
    assert.strictEqual(cache['owner/repo/1'], null);
  });

  test('caches null for issues that are not closed', () => {
    const cache = {};
    const execFn = () => JSON.stringify({ createdAt: '2025-01-01T00:00:00Z' });
    enrichIssueCycleTime(makeIssueMetrics(), cache, execFn);
    assert.strictEqual(cache['owner/repo/1'], null);
  });

  test('caps issueMeta processing at 50 issues', () => {
    let callCount = 0;
    const execFn = () => { callCount++; return JSON.stringify({}); };
    const issueMeta = Array.from({ length: 60 }, (_, i) => ({ repo: 'r', number: i + 1 }));
    const metrics = makeIssueMetrics({ issueMeta });
    enrichIssueCycleTime(metrics, {}, execFn);
    assert.strictEqual(callCount, 50);
  });

  test('preserves all original issueMetrics fields in returned object', () => {
    const execFn = makeExecFn('2025-01-01T00:00:00Z', '2025-01-06T00:00:00Z');
    const metrics = makeIssueMetrics({ mtPerIssue: 1.5, avgImplementHours: 2.3 });
    const result = enrichIssueCycleTime(metrics, {}, execFn);
    assert.strictEqual(result.issuesAddressed, metrics.issuesAddressed);
    assert.strictEqual(result.mtPerIssue, 1.5);
    assert.strictEqual(result.avgImplementHours, 2.3);
  });

  test('rounds avgCycleTimeDays to 2 decimal places', () => {
    // 1 day + 1 second = 1.0000115... days
    const execFn = makeExecFn('2025-01-01T00:00:00Z', '2025-01-02T00:00:01Z');
    const result = enrichIssueCycleTime(makeIssueMetrics(), {}, execFn);
    assert.strictEqual(result.avgCycleTimeDays, Math.round(result.avgCycleTimeDays * 100) / 100);
  });
});

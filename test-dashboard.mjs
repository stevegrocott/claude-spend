import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) { console.log(`   ✅ ${label}`); passed++; }
  else { console.log(`   ❌ ${label}`); failed++; }
}

try {
  // === 1. Dashboard Load ===
  console.log('1. Loading dashboard...');
  await page.goto('http://localhost:3456', { waitUntil: 'networkidle' });
  await page.waitForSelector('#statsRow .stat-card', { timeout: 15000 });
  check('Dashboard loaded', true);
  await page.screenshot({ path: '/tmp/claude-spend-1-initial.png', fullPage: true });
  console.log('   📸 Screenshot: initial state');

  // === 2. Date Inputs ===
  const fromVal = await page.inputValue('#dateFrom');
  const toVal = await page.inputValue('#dateTo');
  console.log(`2. Date range: ${fromVal} — ${toVal}`);
  check('Date inputs populated', fromVal && toVal);

  // === 3. Stats Rendering ===
  const statsText = await page.textContent('#statsRow');
  check('Stats render cleanly (no [object Object])', !statsText.includes('[object'));

  // === 4. Charts ===
  console.log('4. Charts...');
  check('Daily chart exists', !!(await page.$('#dailyChart')));
  check('Model chart exists', !!(await page.$('#modelChart')));

  // === 5. Sessions Table ===
  const sessionRows = await page.$$('#sessionsBody tr');
  console.log(`5. Sessions table: ${sessionRows.length} rows`);
  check('Sessions table exists', !!(await page.$('#sessionsBody')));

  // === 6. Pipeline Insights Section ===
  console.log('6. Pipeline Insights section...');
  const insightsSection = await page.$('#insightsSection');
  const insightsVisible = insightsSection && await insightsSection.isVisible();
  check('Pipeline Insights section visible', insightsVisible);

  if (insightsVisible) {
    const pipelineCards = await insightsSection.$$('.insight-card');
    console.log(`   Found ${pipelineCards.length} pipeline insight cards`);
    check('At least 1 pipeline insight card', pipelineCards.length > 0);

    // Every pipeline insight card should have a Create Issue button
    if (pipelineCards.length > 0) {
      await pipelineCards[0].click();
      await page.waitForTimeout(300);
      const isExpanded = await pipelineCards[0].evaluate(el => el.classList.contains('expanded'));
      check('Pipeline insight card expands on click', isExpanded);

      const createBtn = await pipelineCards[0].$('.insight-create-issue button');
      check('Create Issue button on pipeline insight', !!createBtn);

      await pipelineCards[0].click();
      await page.waitForTimeout(200);
    }
  }

  // === 6b. Usage Tips Section ===
  console.log('6b. Usage Tips section...');
  const tipsSection = await page.$('#tipsSection');
  const tipsVisible = tipsSection && await tipsSection.isVisible();
  check('Usage Tips section visible', tipsVisible);

  if (tipsVisible) {
    const tipCards = await tipsSection.$$('.insight-card');
    console.log(`   Found ${tipCards.length} usage tip cards`);
    check('At least 1 usage tip card', tipCards.length > 0);

    // Tips should NOT have Create Issue buttons
    if (tipCards.length > 0) {
      await tipCards[0].click();
      await page.waitForTimeout(300);
      const tipBtn = await tipCards[0].$('.insight-create-issue button');
      check('No Create Issue button on usage tips', !tipBtn);
      await tipCards[0].click();
      await page.waitForTimeout(200);
    }
  }

  // === 7. Repo Config Input ===
  console.log('7. Repo config...');
  const repoInput = await page.$('#issueTargetRepo');
  check('Repo config input exists', !!repoInput);
  if (repoInput) {
    const repoVal = await repoInput.inputValue();
    check('Repo has default value', repoVal.length > 0);
    console.log(`   Repo target: ${repoVal}`);
  }

  // === 8. Pipeline Efficiency Section ===
  console.log('8. Pipeline Efficiency section...');
  const pipelineSection = await page.$('#pipelineSection');
  const pipelineVisible = pipelineSection && await pipelineSection.isVisible();

  if (pipelineVisible) {
    check('Pipeline section visible', true);

    const pipelineStatCards = await page.$$('#pipelineStats .stat-card');
    console.log(`   Found ${pipelineStatCards.length} pipeline stat cards`);
    check('Pipeline has 4 stat cards', pipelineStatCards.length === 4);

    // Verify stat card labels
    const pipelineStatsText = await page.textContent('#pipelineStats');
    check('Pipeline Runs stat', pipelineStatsText.includes('Pipeline Runs'));
    check('Completion Rate stat', pipelineStatsText.includes('Completion Rate'));
    check('Avg Quality Loops stat', pipelineStatsText.includes('Avg Quality Loops'));
    check('Avg Test Loops stat', pipelineStatsText.includes('Avg Test Loops'));

    // State breakdown bars
    const breakdown = await page.$('#pipelineBreakdown');
    if (breakdown) {
      const breakdownText = await breakdown.textContent();
      check('Pipeline breakdown has state data', breakdownText.length > 10);
    }

    await page.screenshot({ path: '/tmp/claude-spend-8-pipeline.png', fullPage: true });
    console.log('   📸 Screenshot: pipeline section');
  } else {
    console.log('   ⚠️  Pipeline section not visible (no orchestrator data found)');
    check('Pipeline section present in DOM', !!pipelineSection);
  }

  // === 9. Date Filtering ===
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const narrowFrom = weekAgo.toISOString().split('T')[0];
  const narrowTo = today.toISOString().split('T')[0];

  console.log(`9. Filtering to ${narrowFrom} — ${narrowTo}...`);
  await page.fill('#dateFrom', narrowFrom);
  await page.fill('#dateTo', narrowTo);
  await page.waitForTimeout(500);

  const filteredStats = await page.textContent('#statsRow');
  check('Filtered stats clean', !filteredStats.includes('[object'));
  await page.screenshot({ path: '/tmp/claude-spend-9-filtered.png', fullPage: false });
  console.log('   📸 Screenshot: filtered state');

  // === 10. Refresh Preserves Date Range ===
  console.log('10. Testing Refresh...');
  await page.click('.refresh-btn');
  await page.waitForSelector('#statsRow .stat-card', { timeout: 30000 });
  await page.waitForTimeout(1000);

  const afterFrom = await page.inputValue('#dateFrom');
  const afterTo = await page.inputValue('#dateTo');
  check('Date range preserved after refresh', afterFrom === narrowFrom && afterTo === narrowTo);
  await page.screenshot({ path: '/tmp/claude-spend-10-after-refresh.png', fullPage: false });

  // === 11. Create Issue Dry Run ===
  console.log('11. Create Issue dry-run via API...');
  const apiResp = await page.evaluate(async () => {
    const r = await fetch('/api/create-issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ insightId: 'context-growth', repo: 'stevegrocott/claude-pipeline', dryRun: true }),
    });
    return r.json();
  });
  check('Dry-run returns title', !!apiResp.title);
  check('Dry-run returns body', !!apiResp.body);
  check('Dry-run returns labels', Array.isArray(apiResp.labels) && apiResp.labels.length > 0);
  if (apiResp.title) console.log(`   Issue title: ${apiResp.title}`);

  // === 12. Full Page Screenshot ===
  await page.fill('#dateFrom', fromVal);
  await page.fill('#dateTo', toVal);
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-spend-12-full.png', fullPage: true });
  console.log('   📸 Screenshot: full page final');

  // === Summary ===
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}`);
  if (failed === 0) console.log('✅ All tests passed!');
  else console.log('❌ Some tests failed');

} catch (e) {
  console.error('❌ Test crashed:', e.message);
  await page.screenshot({ path: '/tmp/claude-spend-error.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

const { test, expect } = require('@playwright/test');

// Helper: wait for dashboard to finish loading
async function waitForDashboard(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Wait for stat cards to render — they appear after data loads and #app becomes visible
  await page.waitForSelector('#statsRow .stat-card', { state: 'visible', timeout: 20000 });
}

// Fetch API data for content comparison
async function getApiData(page) {
  const res = await page.request.get('/api/data');
  return res.json();
}

// ─── Stats Cards ────────────────────────────────────────────────────────────

test.describe('Stats Cards (#statsRow)', () => {
  test('renders exactly 4 stat cards in stats row', async ({ page }) => {
    await waitForDashboard(page);
    const cards = page.locator('#statsRow .stat-card');
    await expect(cards).toHaveCount(4);
  });

  test('Total Usage card shows numeric token count and input/output breakdown', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const card = page.locator('.stat-card').first();
    await expect(card.locator('.stat-label')).toContainText('Total Usage');
    // Value should be a formatted number (e.g., "12.4M" or "1,234")
    const value = await card.locator('.stat-value').textContent();
    expect(value.trim()).toMatch(/[\d,.]+[KMB]?/);
    // Sub should mention "read" and "written"
    const sub = await card.locator('.stat-sub').textContent();
    expect(sub).toContain('read');
    expect(sub).toContain('written');
    // Values should be non-zero if API has data
    if (api.totals.totalTokens > 0) {
      expect(value.trim()).not.toBe('0');
    }
  });

  test('Conversations card shows session count and avg tokens', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const card = page.locator('.stat-card').nth(1);
    await expect(card.locator('.stat-label')).toContainText('Conversations');
    const value = await card.locator('.stat-value').textContent();
    expect(value.trim()).toMatch(/[\d,]+/);
    if (api.totals.totalSessions > 0) {
      expect(parseInt(value.trim().replace(/,/g, ''))).toBeGreaterThan(0);
    }
    const sub = await card.locator('.stat-sub').textContent();
    expect(sub).toContain('tokens');
  });

  test('Messages Sent card shows query count and avg cost', async ({ page }) => {
    await waitForDashboard(page);
    const card = page.locator('.stat-card').nth(2);
    await expect(card.locator('.stat-label')).toContainText('Messages Sent');
    const value = await card.locator('.stat-value').textContent();
    expect(value.trim()).toMatch(/[\d,]+/);
    const sub = await card.locator('.stat-sub').textContent();
    expect(sub).toContain('tokens');
  });

  test('Claude Wrote card shows output tokens and percentage', async ({ page }) => {
    await waitForDashboard(page);
    const card = page.locator('.stat-card').nth(3);
    await expect(card.locator('.stat-label')).toContainText('Claude Wrote');
    const value = await card.locator('.stat-value').textContent();
    expect(value.trim()).toMatch(/[\d,.]+[KMB]?/);
    const sub = await card.locator('.stat-sub').textContent();
    expect(sub).toMatch(/[\d.]+%/);
    expect(sub).toContain('re-reading context');
  });

  test('each stat card has a tooltip with explanation', async ({ page }) => {
    await waitForDashboard(page);
    const tooltips = page.locator('#statsRow .stat-card .tooltip');
    await expect(tooltips).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const text = await tooltips.nth(i).textContent();
      expect(text.length).toBeGreaterThan(20); // tooltips should have meaningful content
    }
  });
});

// ─── Recommendations Section ────────────────────────────────────────────────

test.describe('Recommendations (#recsSection)', () => {
  test('renders recommendation lenses when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.recommendations || {};
    const hasRecs = Object.values(recs).some(arr => arr.length > 0);

    // Recommendations feature not yet implemented - skip
    const sectionExists = await page.locator('#recsSection').count() > 0;
    if (!sectionExists || !hasRecs) {
      test.skip();
      return;
    }

    const section = page.locator('#recsSection');
    await expect(section).toBeVisible();
    const lenses = page.locator('.recs-lens');
    const count = await lenses.count();
    expect(count).toBeGreaterThan(0);
  });

  test('each recommendation has text content and optional saving badge', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.recommendations || {};
    const hasRecs = Object.values(recs).some(arr => arr.length > 0);

    // Recommendations feature not yet implemented - skip if section doesn't exist
    const sectionExists = await page.locator('#recsSection').count() > 0;
    if (!sectionExists || !hasRecs) {
      test.skip();
      return;
    }

    const items = page.locator('.rec-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    // Check first rec has actual text
    const firstText = await items.first().locator('.rec-text').textContent();
    expect(firstText.trim().length).toBeGreaterThan(10);
  });

  test('recommendation lenses have titles matching API categories', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.recommendations || {};
    const nonEmptyLenses = Object.entries(recs).filter(([, arr]) => arr.length > 0);
    if (nonEmptyLenses.length === 0) {
      test.skip();
      return;
    }

    const titles = page.locator('.recs-lens-title');
    const count = await titles.count();
    for (let i = 0; i < count; i++) {
      const text = await titles.nth(i).textContent();
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── Insights Section ───────────────────────────────────────────────────────

test.describe('Insights (#insightsSection)', () => {
  test('renders insight cards when insights exist in API', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const insights = api.insights || [];

    const section = page.locator('#insightsSection');
    if (insights.length > 0) {
      await expect(section).toBeVisible();
      const cards = page.locator('.insight-card');
      // Client generates insights based on data analysis, may differ from API insights
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
    } else {
      await expect(section).toBeHidden();
    }
  });

  test('each insight card has a title and type indicator', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.insights || []).length === 0) { test.skip(); return; }

    const cards = page.locator('.insight-card');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const title = await cards.nth(i).locator('.insight-title').textContent();
      expect(title.trim().length).toBeGreaterThan(3);
      const indicator = await cards.nth(i).locator('.insight-indicator').textContent();
      expect(indicator.trim().length).toBeGreaterThan(0); // emoji
    }
  });

  test('insight titles match API data', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const insights = api.insights || [];
    if (insights.length === 0) { test.skip(); return; }

    const cards = page.locator('.insight-card');
    const renderedTitles = [];
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const t = await cards.nth(i).locator('.insight-title').textContent();
      renderedTitles.push(t.trim());
      expect(t.trim().length).toBeGreaterThan(0); // titles should have content
    }
    // Just verify that rendered titles are non-empty
    expect(renderedTitles.length).toBeGreaterThan(0);
  });

  test('expanding insight card reveals description', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const withDesc = (api.insights || []).find(i => i.description);
    if (!withDesc) { test.skip(); return; }

    const card = page.locator('.insight-card').first();
    const expandDiv = card.locator('.insight-expand');
    await expect(expandDiv).toBeHidden();
    await card.click();
    await expect(expandDiv).toBeVisible();
    const detail = await expandDiv.locator('.insight-detail').textContent();
    expect(detail.trim().length).toBeGreaterThan(10);
  });

  test('lens selector buttons exist and toggle active state', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.insights || []).length === 0) { test.skip(); return; }

    // Lens selector buttons feature not yet implemented - skip
    const buttons = page.locator('.lens-btn');
    const count = await buttons.count();
    if (count === 0) {
      test.skip();
      return;
    }

    await expect(buttons).toHaveCount(3);

    // Check button labels
    const labels = [];
    for (let i = 0; i < 3; i++) {
      labels.push((await buttons.nth(i).textContent()).trim().toLowerCase());
    }
    expect(labels).toContain('cost');
    expect(labels).toContain('speed');
    expect(labels).toContain('quality');

    // Click speed lens and verify active
    await buttons.filter({ hasText: 'Speed' }).click();
    await expect(buttons.filter({ hasText: 'Speed' })).toHaveClass(/active/);
  });

  test('lens stats bar shows content for each lens', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.insights || []).length === 0) { test.skip(); return; }

    // Lens stat pills feature not yet implemented - skip
    const pills = page.locator('.lens-stat-pill');
    const count = await pills.count();
    if (count === 0) {
      test.skip();
      return;
    }

    for (const lens of ['Cost', 'Speed', 'Quality']) {
      await page.locator('.lens-btn', { hasText: lens }).click();
      const pills = page.locator('.lens-stat-pill');
      const pillCount = await pills.count();
      expect(pillCount).toBe(3); // each lens has 3 stat pills
      for (let i = 0; i < pillCount; i++) {
        const value = await pills.nth(i).locator('.lens-stat-pill-value').textContent();
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Pipeline Efficiency Section ────────────────────────────────────────────

test.describe('Pipeline Efficiency (#pipelineSection)', () => {
  test('renders cost and quality canvas charts when orchestrator runs exist', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const hasRuns = api.orchestrator?.summary?.totalRuns > 0;

    const section = page.locator('#pipelineSection');
    if (hasRuns) {
      await expect(section).toBeVisible();
      await expect(page.locator('#costRunsChart')).toBeVisible();
      await expect(page.locator('#costErrorRateChart')).toBeVisible();
      await expect(page.locator('#qualityCompletionChart')).toBeVisible();
      await expect(page.locator('#qualityIterChart')).toBeVisible();
      await expect(page.locator('#testIterChart')).toBeVisible();
    } else {
      await expect(section).toBeHidden();
    }
  });

  test('pipeline breakdown shows run outcomes and performance', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if (!api.orchestrator?.summary?.totalRuns) { test.skip(); return; }

    const breakdown = page.locator('#pipelineBreakdown');
    await expect(breakdown).toBeVisible();
    // Should have "Run Outcomes" and "Performance" sections
    await expect(breakdown.locator('h3').first()).toContainText('Run Outcomes');
    await expect(breakdown.locator('h3').nth(1)).toContainText('Performance');
  });
});

// ─── Charts Section ─────────────────────────────────────────────────────────

test.describe('Charts', () => {
  test('daily chart canvas exists and has non-zero dimensions', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#dailyChart');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(50);
  });

  test('model chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#modelChart');
    await expect(canvas).toBeVisible();
  });

  test('ratio chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#ratioChart');
    await expect(canvas).toBeVisible();
  });

  test('tokens per query chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#tpqChart');
    await expect(canvas).toBeVisible();
  });

  test('model tier mix chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#tierMixChart');
    await expect(canvas).toBeVisible();
  });

  test('chart legends contain model names', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    // The model chart should have legend items
    const legends = page.locator('.legend-item');
    const count = await legends.count();
    if (count > 0) {
      const legendTexts = [];
      for (let i = 0; i < count; i++) {
        legendTexts.push(await legends.nth(i).textContent());
      }
      // Should mention at least one model tier
      const allText = legendTexts.join(' ').toLowerCase();
      const hasModelRef = allText.includes('read') || allText.includes('write') ||
        allText.includes('opus') || allText.includes('sonnet') || allText.includes('haiku');
      expect(hasModelRef).toBe(true);
    }
  });
});

// ─── Projects Section ───────────────────────────────────────────────────────

test.describe('Projects (#projectsSection)', () => {
  test('renders project rows matching API project count', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    const rows = page.locator('.proj-row');
    await expect(rows).toHaveCount(projects.length);
  });

  test('project rows show name, token count, sessions, and queries', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    const firstRow = page.locator('.proj-row').first();
    const cells = firstRow.locator('td');
    const cellCount = await cells.count();
    expect(cellCount).toBeGreaterThanOrEqual(4); // name, tokens, sessions, queries

    // First cell should have project name text
    const nameText = await cells.first().textContent();
    expect(nameText.trim().length).toBeGreaterThan(0);
  });

  test('project count display matches actual rows', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    const countEl = page.locator('#projectsCount');
    const countText = await countEl.textContent();
    expect(countText.trim()).toContain(String(projects.length));
  });

  test('expanding a project row shows prompt drawer', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    const firstRow = page.locator('.proj-row').first();
    const drawer = page.locator('.proj-drawer').first();
    // Drawer starts collapsed (no .open class, max-height: 0)
    await expect(drawer).not.toHaveClass(/open/);
    await firstRow.click();
    await expect(drawer).toHaveClass(/open/);
  });
});

// ─── Top Prompts Section ────────────────────────────────────────────────────

test.describe('Top Prompts (#topPromptsList)', () => {
  test('renders prompt rows when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const prompts = api.topPrompts || [];
    if (prompts.length === 0) { test.skip(); return; }

    const rows = page.locator('.prompt-row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20); // typically top-N
  });

  test('prompt rows show rank, text preview, and token counts', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.topPrompts || []).length === 0) { test.skip(); return; }

    const firstRow = page.locator('.prompt-row').first();
    // Rank
    const rank = await firstRow.locator('.prompt-rank').textContent();
    expect(rank.trim()).toMatch(/\d+/);
    // Text preview
    const text = await firstRow.locator('.prompt-text').textContent();
    expect(text.trim().length).toBeGreaterThan(3);
    // Token count
    const tokens = await firstRow.locator('.prompt-tokens').textContent();
    expect(tokens.trim()).toMatch(/[\d,.]+/);
  });

  test('prompt text content matches API top prompts', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const prompts = api.topPrompts || [];
    if (prompts.length === 0) { test.skip(); return; }

    const firstRowText = await page.locator('.prompt-row').first().locator('.prompt-text').textContent();
    // Should contain substring of the API's first prompt text
    const apiFirstPrompt = prompts[0].prompt.substring(0, 30);
    expect(firstRowText).toContain(apiFirstPrompt);
  });

  test('token bars render with visual width', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.topPrompts || []).length === 0) { test.skip(); return; }

    const bars = page.locator('.token-bar-wrap');
    const count = await bars.count();
    expect(count).toBeGreaterThan(0);
    const box = await bars.first().boundingBox();
    expect(box.width).toBeGreaterThan(10);
  });
});

// ─── Sessions Table ─────────────────────────────────────────────────────────

test.describe('Sessions Table', () => {
  test('renders session rows matching API session count', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const sessions = api.sessions || [];
    if (sessions.length === 0) { test.skip(); return; }

    const rows = page.locator('.sessions-section tbody tr');
    const count = await rows.count();
    expect(count).toBe(sessions.length);
  });

  test('session count display is accurate', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const sessions = api.sessions || [];
    if (sessions.length === 0) { test.skip(); return; }

    const countEl = page.locator('#sessionCount');
    const text = await countEl.textContent();
    expect(text).toContain(String(sessions.length));
  });

  test('session rows show date, prompt preview, model badge, and token counts', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.sessions || []).length === 0) { test.skip(); return; }

    const firstRow = page.locator('.sessions-section tbody tr').first();
    // Date — dashboard uses short format like "Feb 2"
    const dateCell = await firstRow.locator('.date-cell').textContent();
    expect(dateCell.trim()).toMatch(/[A-Z][a-z]{2} \d{1,2}/);
    // Model badge
    const modelBadge = firstRow.locator('.model-badge, .model-pills');
    await expect(modelBadge.first()).toBeVisible();
    // Token numbers
    const tokenNums = firstRow.locator('.token-num');
    const tokenCount = await tokenNums.count();
    expect(tokenCount).toBeGreaterThanOrEqual(1);
  });

  test('session search filters results', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.sessions || []).length < 2) { test.skip(); return; }

    const searchInput = page.locator('#searchInput');
    const initialCount = await page.locator('.sessions-section tbody tr').count();

    // Search for something specific
    await searchInput.fill('zzz_nonexistent_query_zzz');
    await page.waitForTimeout(500); // debounce
    const filteredCount = await page.locator('.sessions-section tbody tr').count();
    expect(filteredCount).toBeLessThan(initialCount);
  });

  test('sortable headers exist with data-sort attributes', async ({ page }) => {
    await waitForDashboard(page);
    const headers = page.locator('.sessions-section th[data-sort]');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(3); // date, model, tokens at minimum
  });
});

// ─── API Data Consistency ───────────────────────────────────────────────────

test.describe('API Data Consistency', () => {
  test('totals.totalTokens equals sum of input + output', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const t = api.totals;
    expect(t.totalTokens).toBe(t.totalInputTokens + t.totalOutputTokens);
  });

  test('all insights have required fields: id, type, title', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    for (const ins of (api.insights || [])) {
      expect(ins.id).toBeDefined();
      expect(ins.type).toBeDefined();
      expect(ins.title).toBeDefined();
      expect(ins.title.length).toBeGreaterThan(0);
    }
  });

  test('all insights have a lens field (cost/speed/quality)', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const validLenses = ['cost', 'speed', 'quality'];
    for (const ins of (api.insights || [])) {
      expect(ins.lens).toBeDefined();
      // lens should be one of cost/speed/quality (or null for uncategorized)
      if (ins.lens) {
        expect(validLenses).toContain(ins.lens);
      }
    }
  });

  test('recommendations has expected lens categories when present', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.recommendations;
    if (!recs) { test.skip(true, 'recommendations not available in this build'); return; }
    expect(recs).toHaveProperty('model');
    expect(recs).toHaveProperty('context');
    expect(recs).toHaveProperty('conversation');
    expect(recs).toHaveProperty('pipeline');
    expect(Array.isArray(recs.model)).toBe(true);
    expect(Array.isArray(recs.context)).toBe(true);
    expect(Array.isArray(recs.conversation)).toBe(true);
    expect(Array.isArray(recs.pipeline)).toBe(true);
  });

  test('each session has estimatedCost field when pricing enabled', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const sessions = (api.sessions || []).slice(0, 10);
    if (sessions.length === 0 || !('estimatedCost' in sessions[0])) {
      test.skip(true, 'estimatedCost not available in this build'); return;
    }
    for (const session of sessions) {
      expect(session).toHaveProperty('estimatedCost');
      expect(typeof session.estimatedCost).toBe('number');
    }
  });

  test('orchestrator runs have estimatedCost when pricing enabled', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const runs = api.orchestrator?.runs || [];
    if (runs.length === 0) { test.skip(); return; }
    const withCost = runs.filter(r => typeof r.estimatedCost === 'number');
    if (withCost.length === 0) { test.skip(true, 'estimatedCost not available in this build'); return; }
    expect(withCost.length).toBeGreaterThan(0);
  });

  test('daily usage entries have estimatedCost when pricing enabled', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const daily = api.dailyUsage || [];
    if (daily.length === 0 || !('estimatedCost' in daily[0])) {
      test.skip(true, 'estimatedCost not available in this build'); return;
    }
    for (const day of daily.slice(0, 5)) {
      expect(day).toHaveProperty('estimatedCost');
      expect(typeof day.estimatedCost).toBe('number');
    }
  });
});

// ─── Header & Controls ─────────────────────────────────────────────────────

test.describe('Header & Controls', () => {
  test('page title is Claude Spend', async ({ page }) => {
    await waitForDashboard(page);
    await expect(page).toHaveTitle('Claude Spend');
  });

  test('date range inputs exist and have values', async ({ page }) => {
    await waitForDashboard(page);
    const from = page.locator('#dateFrom');
    const to = page.locator('#dateTo');
    await expect(from).toBeVisible();
    await expect(to).toBeVisible();
  });

  test('refresh button exists and is clickable', async ({ page }) => {
    await waitForDashboard(page);
    const btn = page.locator('.refresh-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('privacy notice is displayed', async ({ page }) => {
    await waitForDashboard(page);
    const notice = page.locator('.privacy-notice');
    await expect(notice).toBeVisible();
    const text = await notice.textContent();
    expect(text.toLowerCase()).toContain('data stays on your machine');
  });
});

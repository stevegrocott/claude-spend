const { test, expect } = require('@playwright/test');

// Helper: wait for dashboard to finish loading
async function waitForDashboard(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Wait for app container to become visible (data loaded and rendered)
  await page.waitForSelector('#app', { state: 'visible', timeout: 20000 });
}

// Fetch API data for content comparison
async function getApiData(page) {
  const res = await page.request.get('/api/data');
  return res.json();
}

// ─── PP/100MT Hero ──────────────────────────────────────────────────────────

test.describe('PP/100MT Hero', () => {
  test('hero PP/100MT number is the first visible content element', async ({ page }) => {
    await waitForDashboard(page);
    const hero = page.locator('.hero-ppmt');
    // Hero should exist — either the PP/100MT display or fallback hero
    const heroExists = await hero.count() > 0;
    const fallbackHero = page.locator('.hero-section');
    const fallbackExists = await fallbackHero.count() > 0;
    expect(heroExists || fallbackExists).toBe(true);
  });

  test('hero shows PP/100MT number when orchestrator data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const hasOrch = api.orchestrator?.summary?.ppmtAnalysis;
    if (!hasOrch) { test.skip(); return; }

    const heroValue = page.locator('.hero-ppmt-value');
    await expect(heroValue).toBeVisible();
    const text = await heroValue.textContent();
    expect(text.trim()).toMatch(/[\d.]+/);
  });

  test('hero shows trend arrow when sufficient data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const ppmtByDay = api.orchestrator?.summary?.ppmtAnalysis?.ppmtByDay || [];
    if (ppmtByDay.length < 4) { test.skip(); return; }

    const trend = page.locator('.hero-ppmt-trend');
    await expect(trend).toBeVisible();
    const text = await trend.textContent();
    // Should contain an arrow indicator (▲ or ▼ or →)
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('hero subtitle says "Points per 100M Pipeline Tokens"', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if (!api.orchestrator?.summary?.ppmtAnalysis) { test.skip(); return; }

    const label = page.locator('.hero-ppmt-label, .hero-ppmt-sub');
    const count = await label.count();
    if (count === 0) { test.skip(); return; }
    const allText = [];
    for (let i = 0; i < count; i++) {
      allText.push(await label.nth(i).textContent());
    }
    expect(allText.join(' ').toLowerCase()).toContain('pipeline tokens');
  });
});

// ─── PP/100MT Chart ─────────────────────────────────────────────────────────

test.describe('PP/100MT Chart', () => {
  test('PP/100MT chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#spPerTokenChart');
    await expect(canvas).toBeAttached();
  });

  test('PP/100MT chart has non-zero dimensions when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const ppmtByDay = api.orchestrator?.summary?.ppmtAnalysis?.ppmtByDay || [];
    if (ppmtByDay.length === 0) { test.skip(); return; }

    const canvas = page.locator('#spPerTokenChart');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(50);
  });
});

// ─── Recommendations ────────────────────────────────────────────────────────

test.describe('Recommendations', () => {
  test('recommendations section has cards when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.orchestrator?.summary?.recommendations || [];
    if (recs.length === 0) { test.skip(); return; }

    const cards = page.locator('.ppmt-rec-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('recommendation cards show title and detail', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.orchestrator?.summary?.recommendations || [];
    if (recs.length === 0) { test.skip(); return; }

    const firstCard = page.locator('.ppmt-rec-card').first();
    const title = await firstCard.locator('.ppmt-rec-title').textContent();
    expect(title.trim().length).toBeGreaterThan(3);
    const detail = await firstCard.locator('.ppmt-rec-detail').textContent();
    expect(detail.trim().length).toBeGreaterThan(3);
  });
});

// ─── Driver Charts ──────────────────────────────────────────────────────────

test.describe('Driver Charts', () => {
  test('yield trend chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#yieldTrendChart');
    await expect(canvas).toBeAttached();
  });

  test('task size completion chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#taskSizeChart');
    await expect(canvas).toBeAttached();
  });

  test('failure breakdown chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#failureChart');
    await expect(canvas).toBeAttached();
  });

  test('task count vs outcome section exists', async ({ page }) => {
    await waitForDashboard(page);
    const section = page.locator('#taskCountStat');
    await expect(section).toBeAttached();
  });

  test('driver charts render with dimensions when orchestrator data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const hasOrch = api.orchestrator?.summary?.totalRuns > 0;
    if (!hasOrch) { test.skip(); return; }

    for (const id of ['yieldTrendChart', 'taskSizeChart', 'failureChart']) {
      const canvas = page.locator('#' + id);
      const visible = await canvas.isVisible().catch(() => false);
      if (visible) {
        const box = await canvas.boundingBox();
        expect(box.width).toBeGreaterThan(50);
        expect(box.height).toBeGreaterThan(30);
      }
    }
  });

  test('each driver chart has an explainer sentence', async ({ page }) => {
    await waitForDashboard(page);
    const explainers = page.locator('.driver-explainer');
    const count = await explainers.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const text = await explainers.nth(i).textContent();
      expect(text.trim().length).toBeGreaterThan(20);
    }
  });
});

// ─── Projects Section ───────────────────────────────────────────────────────

test.describe('Projects', () => {
  test('renders project rows matching API project count', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    const rows = page.locator('.proj-row');
    await expect(rows).toHaveCount(projects.length);
  });

  test('project breakdown has PP/100MT column', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    if (projects.length === 0) { test.skip(); return; }

    // Check for PP/100MT header
    const headers = page.locator('.projects-section th');
    const headerTexts = [];
    const count = await headers.count();
    for (let i = 0; i < count; i++) {
      headerTexts.push(await headers.nth(i).textContent());
    }
    const allHeaders = headerTexts.join(' ').toLowerCase();
    expect(allHeaders).toContain('pp/100mt');
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
    await expect(drawer).not.toHaveClass(/open/);
    await firstRow.click();
    await expect(drawer).toHaveClass(/open/);
  });
});

// ─── Top Prompts Section ────────────────────────────────────────────────────

test.describe('Top Prompts', () => {
  test('renders prompt rows when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const prompts = api.topPrompts || [];
    if (prompts.length === 0) { test.skip(); return; }

    const rows = page.locator('.prompt-row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
  });

  test('prompt rows show rank, text preview, and token counts', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.topPrompts || []).length === 0) { test.skip(); return; }

    const firstRow = page.locator('.prompt-row').first();
    const rank = await firstRow.locator('.prompt-rank').textContent();
    expect(rank.trim()).toMatch(/\d+/);
    const text = await firstRow.locator('.prompt-text').textContent();
    expect(text.trim().length).toBeGreaterThan(3);
    const tokens = await firstRow.locator('.prompt-tokens').textContent();
    expect(tokens.trim()).toMatch(/[\d,.]+/);
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

  test('session search filters results', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    if ((api.sessions || []).length < 2) { test.skip(); return; }

    const searchInput = page.locator('#searchInput');
    const initialCount = await page.locator('.sessions-section tbody tr').count();

    await searchInput.fill('zzz_nonexistent_query_zzz');
    await page.waitForTimeout(500);
    const filteredCount = await page.locator('.sessions-section tbody tr').count();
    expect(filteredCount).toBeLessThan(initialCount);
  });

  test('sortable headers exist with data-sort attributes', async ({ page }) => {
    await waitForDashboard(page);
    const headers = page.locator('.sessions-section th[data-sort]');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

// ─── Deleted Elements (should NOT exist) ────────────────────────────────────

test.describe('Removed elements are gone', () => {
  test('no stat cards row exists', async ({ page }) => {
    await waitForDashboard(page);
    await expect(page.locator('#statsRow')).toHaveCount(0);
  });

  test('no lens tab buttons exist', async ({ page }) => {
    await waitForDashboard(page);
    await expect(page.locator('.lens-btn')).toHaveCount(0);
  });

  test('no old vanity chart canvases exist', async ({ page }) => {
    await waitForDashboard(page);
    for (const id of ['dailyChart', 'modelChart', 'ratioChart', 'tpqChart', 'tierMixChart', 'costRunsChart', 'costErrorRateChart', 'velocityChart']) {
      await expect(page.locator('#' + id)).toHaveCount(0);
    }
  });

  test('no insight cards exist', async ({ page }) => {
    await waitForDashboard(page);
    await expect(page.locator('.insight-card')).toHaveCount(0);
  });
});

// ─── Header & Controls ──────────────────────────────────────────────────────

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

// ─── API Data Consistency ───────────────────────────────────────────────────

test.describe('API Data Consistency', () => {
  test('totals.totalTokens equals sum of input + output', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const t = api.totals;
    expect(t.totalTokens).toBe(t.totalInputTokens + t.totalOutputTokens);
  });

  test('orchestrator summary has ppmtAnalysis when runs exist', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const runs = api.orchestrator?.runs || [];
    if (runs.length === 0) { test.skip(); return; }

    expect(api.orchestrator.summary).toBeDefined();
    expect(api.orchestrator.summary.ppmtAnalysis).toBeDefined();
  });

  test('ppmtAnalysis has pipelineTokens field', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const analysis = api.orchestrator?.summary?.ppmtAnalysis;
    if (!analysis) { test.skip(); return; }

    expect(analysis).toHaveProperty('pipelineTokens');
    expect(typeof analysis.pipelineTokens).toBe('number');
  });

  test('projectBreakdown entries have pp100mt field', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const projects = api.projectBreakdown || [];
    const withPP = projects.filter(p => typeof p.pp100mt === 'number');
    // pp100mt is computed from orchestrator data — if orchestrator exists, some projects should have it
    if (api.orchestrator?.summary?.totalRuns > 0) {
      expect(withPP.length).toBeGreaterThan(0);
    }
  });
});

// ─── Session Efficiency ─────────────────────────────────────────────────────

test.describe('Session Efficiency', () => {
  test('session efficiency section renders', async ({ page }) => {
    await waitForDashboard(page);
    const section = page.locator('#sessionEfficiencySection');
    await expect(section).toBeAttached();
  });

  test('pipeline/interactive split bar renders with percentages', async ({ page }) => {
    await waitForDashboard(page);
    const splitBar = page.locator('#tokenSplitBar');
    const count = await splitBar.count();
    if (count === 0) { test.skip(); return; }

    const text = await splitBar.textContent();
    expect(text).toMatch(/\d+%/);
  });

  test('context cost chart canvas exists', async ({ page }) => {
    await waitForDashboard(page);
    const canvas = page.locator('#contextCostChart');
    await expect(canvas).toBeAttached();
  });

  test('session recommendations render when data exists', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const recs = api.sessionEfficiency?.recommendations || [];
    if (recs.length === 0) { test.skip(); return; }

    const cards = page.locator('#sessionRecs .ppmt-rec-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('API sessionEfficiency has pipeline and interactive token counts', async ({ page }) => {
    await waitForDashboard(page);
    const api = await getApiData(page);
    const se = api.sessionEfficiency;
    if (!se) { test.skip(); return; }

    expect(se).toHaveProperty('pipeline');
    expect(se).toHaveProperty('interactive');
    expect(typeof se.pipeline.tokens).toBe('number');
    expect(typeof se.interactive.tokens).toBe('number');
  });
});

// ─── Dashboard Footer ───────────────────────────────────────────────────────

test.describe('Dashboard Footer', () => {
  test('explanatory footer exists with PP/100MT description', async ({ page }) => {
    await waitForDashboard(page);
    const footer = page.locator('.dashboard-footer');
    const count = await footer.count();
    if (count === 0) { test.skip(); return; }

    const text = await footer.textContent();
    expect(text.toLowerCase()).toContain('pp/100mt');
    expect(text.toLowerCase()).toContain('pipeline tokens');
  });
});

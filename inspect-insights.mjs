import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
await page.goto('http://localhost:3456', { waitUntil: 'networkidle', timeout: 30000 });

// Pipeline Insights section
const insightsSection = await page.$('#insightsSection');
if (insightsSection && await insightsSection.isVisible()) {
  console.log('=== PIPELINE INSIGHTS ===');
  const cards = await insightsSection.$$('.insight-card');
  for (const card of cards) {
    const title = await card.$eval('.insight-title', el => el.textContent);
    const btn = await card.$('.insight-create-issue button');
    console.log(`  [${btn ? 'CREATE ISSUE' : 'no button'}] ${title}`);
  }
  await insightsSection.screenshot({ path: '/tmp/claude-spend-pipeline-insights.png' });
  console.log(`  📸 ${cards.length} cards`);
} else {
  console.log('Pipeline Insights section: hidden');
}

// Usage Tips section
const tipsSection = await page.$('#tipsSection');
if (tipsSection && await tipsSection.isVisible()) {
  console.log('\n=== USAGE TIPS ===');
  const cards = await tipsSection.$$('.insight-card');
  for (const card of cards) {
    const title = await card.$eval('.insight-title', el => el.textContent);
    const btn = await card.$('.insight-create-issue button');
    console.log(`  [${btn ? 'CREATE ISSUE' : 'tip'}] ${title}`);
  }
  await tipsSection.screenshot({ path: '/tmp/claude-spend-usage-tips.png' });
  console.log(`  📸 ${cards.length} cards`);
} else {
  console.log('Usage Tips section: hidden');
}

// Pipeline Efficiency section
const pipelineSection = await page.$('#pipelineSection');
if (pipelineSection && await pipelineSection.isVisible()) {
  await pipelineSection.screenshot({ path: '/tmp/claude-spend-pipeline-efficiency.png' });
  console.log('\n📸 Pipeline Efficiency section captured');
}

await browser.close();

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../app/server/index.js';
import { domains } from '../app/server/catalog.js';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightPath);
const root = path.dirname(fileURLToPath(import.meta.url));
const examples = JSON.parse(await fs.readFile(path.join(root, 'examples.json'), 'utf8'));
if (examples.length !== 10 || examples.some(({ result }) => result.status !== 'draft' || !result.sql)) {
  throw new Error('Ten reviewed SQL drafts are required before capturing screenshots.');
}

const sizes = [
  { label: 'desktop', width: 1440, height: 900, scale: 1.5 },
  { label: 'desktop-wide', width: 1600, height: 1000, scale: 1.5 },
  { label: 'laptop', width: 1280, height: 800, scale: 1.5 },
  { label: 'tablet-landscape', width: 1024, height: 768, scale: 2 },
  { label: 'tablet-portrait', width: 820, height: 1180, scale: 2 },
  { label: 'tablet-compact', width: 768, height: 1024, scale: 2 },
  { label: 'phone-large', width: 430, height: 932, scale: 2 },
  { label: 'phone', width: 390, height: 844, scale: 2 },
  { label: 'phone-compact', width: 375, height: 812, scale: 2 },
  { label: 'phone-small', width: 360, height: 800, scale: 2 },
];

const outputDir = path.join(root, 'screenshots');
await fs.mkdir(outputDir, { recursive: true });
const server = createAppServer({ auth: { close() {} } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
});

try {
  const manifest = [];
  for (const [index, example] of examples.entries()) {
    const size = sizes[index];
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      isMobile: size.label.startsWith('phone'),
      hasTouch: size.label.startsWith('phone'),
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let payload;
      if (pathname === '/api/auth/session') payload = { authenticated: true, device: { label: 'Portfolio demo' } };
      else if (pathname === '/api/status') payload = { elasticsearch: { available: true, status: 'green' }, model_configured: true, tables: 100, metadata_status: 'synthetic_fixture' };
      else if (pathname === '/api/domains') payload = { domains };
      else if (pathname === '/api/generate') payload = example.result;
      else if (pathname === '/api/search') payload = { tables: example.result.retrieved_tables || [], metadata_status: 'synthetic_fixture' };
      else return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('#domain-select').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, example.domain);
    await page.locator('#question').fill(example.question);
    await page.locator('#generate-button').click();
    await page.getByText('Draft ready for review').waitFor();
    await page.locator('#sql-editor').evaluate((element) => { element.style.height = `${element.scrollHeight}px`; });
    const filename = `${String(index + 1).padStart(2, '0')}-${example.slug}-${size.label}.png`;
    const filenamePath = path.join(outputDir, filename);
    await page.screenshot({ path: filenamePath, fullPage: true, animations: 'disabled' });
    manifest.push({ file: filename, prompt: example.question, viewport: `${size.width}×${size.height}`, status: example.result.status, sql: example.result.sql });
    console.log(`${index + 1}/10 ${filename}`);
    await context.close();
  }
  await fs.writeFile(path.join(root, 'screenshots.json'), JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * Renders each recorded example in the real PWA at one viewport per example,
 * and saves full-page screenshots.
 *
 * It drives a Chromium that is already running with remote debugging
 * (`--remote-debugging-port=9222`), through the DevTools protocol and Node's
 * built-in WebSocket: no Playwright or Puppeteer, neither of which ships a
 * Chromium for linux/arm64. The app server runs in this process; the
 * browser's API calls are answered with the recorded example, so the capture
 * needs no invite, key, Elasticsearch or model.
 *
 *   CDP_URL=http://localhost:9222 node portfolio/capture-screenshots.mjs
 *
 * A headless Chromium to point it at, on a host with podman:
 *
 *   podman run -d --name shot --network host --userns=keep-id --shm-size=1g \
 *     --entrypoint chromium-browser docker.io/zenika/alpine-chrome:latest \
 *     --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
 *     --hide-scrollbars --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 about:blank
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../app/server/index.js';
import { domains } from '../app/server/catalog.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const examples = JSON.parse(await fs.readFile(path.join(root, 'examples.json'), 'utf8'));
const unverified = examples.filter(({ result, verified }) => result.status !== 'draft' || !result.sql || verified?.correct !== true);
if (examples.length !== 10 || unverified.length) {
  throw new Error(`Ten drafts verified correct are required first (verify-examples.mjs). Not ready: ${unverified.map((e) => e.slug).join(', ') || `${examples.length} examples`}`);
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

// ------------------------------------------------------------ DevTools

async function devtools(base) {
  const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot reach Chromium at ${base}`)); });
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject, timer } = waiting.get(message.id);
      waiting.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id;
    // A reply that never comes should say which command it was.
    const timer = setTimeout(() => { waiting.delete(messageId); reject(new Error(`${method} timed out`)); }, 30_000);
    waiting.set(messageId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
  });
  return { send, on: (fn) => listeners.add(fn), close: () => ws.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(browser, baseUrl, example, size, file) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const reply = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(`page threw: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value;
  };
  const until = async (expression, what) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };

  // The API answers from the recorded example; everything else is the real app.
  const answers = {
    '/api/auth/session': { authenticated: true, device: { label: 'Portfolio demo' } },
    '/api/status': { elasticsearch: { available: true, status: 'green' }, model_configured: true, tables: 100, metadata_status: 'synthetic_fixture' },
    '/api/domains': { domains },
    '/api/generate': example.result,
    '/api/search': { tables: example.result.retrieved_tables || [], metadata_status: 'synthetic_fixture' },
  };
  browser.on(async (message) => {
    if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const answer = answers[new URL(request.url).pathname];
    if (!answer) { s('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    s('Fetch.fulfillRequest', {
      requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(answer)).toString('base64'),
    }).catch(() => {});
  });

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Network.setBypassServiceWorker', { bypass: true });
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  const phone = size.label.startsWith('phone');
  await s('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: phone });
  await s('Emulation.setTouchEmulationEnabled', { enabled: phone });

  await s('Page.navigate', { url: baseUrl });
  await until(`!!document.getElementById('workspace') && !document.getElementById('workspace').hidden`, 'the workspace');
  await until(`document.querySelectorAll('#domain-select option').length > 1`, 'the subject areas');
  await evaluate(`(() => {
    const select = document.getElementById('domain-select');
    select.value = ${JSON.stringify(example.domain)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const question = document.getElementById('question');
    question.value = ${JSON.stringify(example.question)};
    question.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('generate-button').click();
  })()`);
  await until(`document.getElementById('result-status').textContent.includes('Draft ready for review')`, 'the draft');
  // The whole draft and no empty box beneath it, the fonts settled, and no
  // update notice: a fresh browser lets the PWA's updater reload the page once,
  // and it announces that in a toast.
  await evaluate(`(async () => {
    const editor = document.getElementById('sql-editor');
    editor.style.minHeight = '0';
    editor.style.height = 'auto';
    editor.style.height = Math.max(160, editor.scrollHeight + 2) + 'px';
    for (const node of document.querySelectorAll('body *')) {
      if (node.children.length === 0 && /updated to the latest version/.test(node.textContent)) (node.closest('[role="status"], .toast, div') ?? node).remove();
    }
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
  const { cssContentSize } = await s('Page.getLayoutMetrics');
  const { data } = await s('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: Math.ceil(cssContentSize.height), scale: 1 },
  });
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  await browser.send('Target.closeTarget', { targetId });
}

// ---------------------------------------------------------------- run

const outputDir = path.join(root, 'screenshots');
await fs.mkdir(outputDir, { recursive: true });
const server = createAppServer({ auth: { close() {} } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await devtools(process.env.CDP_URL || 'http://localhost:9222');

try {
  // Screenshots from an earlier set are replaced, not left beside the new one.
  for (const old of (await fs.readdir(outputDir)).filter((f) => /^\d\d-.*\.png$/.test(f))) await fs.rm(path.join(outputDir, old));
  const manifest = [];
  for (const [index, example] of examples.entries()) {
    const size = sizes[index];
    const filename = `${String(index + 1).padStart(2, '0')}-${example.slug}-${size.label}.png`;
    await capture(browser, baseUrl, example, size, path.join(outputDir, filename));
    manifest.push({ file: filename, prompt: example.question, benchmark_case: example.case_id, verified_correct: example.verified.correct, viewport: `${size.width}×${size.height}`, status: example.result.status, sql: example.result.sql });
    console.log(`${index + 1}/10 ${filename}`);
  }
  await fs.writeFile(path.join(root, 'screenshots.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  browser.close();
  await new Promise((resolve) => server.close(resolve));
}

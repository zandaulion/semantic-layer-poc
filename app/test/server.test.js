import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthStore } from '../server/auth.js';
import { config } from '../server/config.js';
import { createAppServer } from '../server/index.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('invite gate, catalog search, draft generation, and check work together', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banking-server-'));
  let modelCalls = 0;
  const fake = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/_cluster/health') return res.end(JSON.stringify({ status: 'green' }));
    if (req.url.endsWith('/_search')) return res.end(JSON.stringify({ hits: { hits: [{ _score: 5, _source: {
      document_id: 'table.bank_dwh.dim_customer', table_name: 'dim_customer', title: 'Customer',
      grain: 'one row per customer', domain_id: 'conformed', table_type: 'dimension',
    } }] } }));
    if (req.url === '/chat/completions') {
      modelCalls++;
      if (modelCalls === 1) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 'json_validate_failed', message: 'Transient output validation failure' } }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      status: 'draft', sql: 'SELECT customer_key FROM bank_dwh.dim_customer',
      interpretation: 'Customer keys', assumptions: [], clarification_question: null,
      sources: ['table.bank_dwh.dim_customer'],
      }) } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const fakeUrl = await listen(fake);
  const old = { elasticUrl: config.elasticUrl, modelBaseUrl: config.modelBaseUrl, modelApiKey: config.modelApiKey, adminToken: config.adminToken, cookieSecure: config.cookieSecure };
  Object.assign(config, { elasticUrl: fakeUrl, modelBaseUrl: fakeUrl, modelApiKey: 'test-key', adminToken: 'admin-test-key', cookieSecure: false });
  const auth = new AuthStore(path.join(dir, 'auth.sqlite'));
  const app = createAppServer({ auth });
  const base = await listen(app);
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
    Object.assign(config, old);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${base}/api/domains`);
  assert.equal(unauthorized.status, 401);
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Bank DWH Studio/);
  const adminDenied = await fetch(`${base}/api/admin/invites`);
  assert.equal(adminDenied.status, 404);
  const created = await fetch(`${base}/api/admin/invites`, {
    method: 'POST', headers: { 'x-admin-token': 'admin-test-key', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Tester' }),
  });
  assert.equal(created.status, 201);
  const { code } = await created.json();
  const redeemed = await fetch(`${base}/api/auth/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'Test browser' }),
  });
  assert.equal(redeemed.status, 200);
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal((await session.json()).device.label, 'Test browser');
  const status = await fetch(`${base}/api/status`, { headers: { cookie } });
  assert.equal((await status.json()).elasticsearch.available, true);
  const search = await fetch(`${base}/api/search?q=customers&domain=conformed`, { headers: { cookie } });
  assert.equal((await search.json()).tables[0].table_name, 'dim_customer');
  const generated = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'List customers', domain: 'conformed' }),
  });
  const draft = await generated.json();
  assert.equal(generated.status, 200);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.checks.tables, 'passed');
  assert.equal(modelCalls, 2);
  const bad = await fetch(`${base}/api/check`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'DELETE FROM bank_dwh.dim_customer' }),
  });
  assert.equal((await bad.json()).checks.statement, 'failed');
});

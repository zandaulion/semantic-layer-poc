import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore, clearCookie, constantTimeTokenMatch, cookieForToken, tokenFromCookie } from './auth.js';
import { config } from './config.js';
import { loadBenchResults } from './bench-results.js';
import { benchAvailable, benchRequest, mayRunBench } from './bench-runner.js';
import { domains, tables, DOCUMENT_STATUS } from './catalog.js';
import { elasticHealth, searchTables } from './elastic.js';
import { answerQuestion } from './answer.js';
import { checkSql } from './sql-check.js';
import { checksAfterExecution, explainWarehouseQuery, runWarehouseQuery, warehouseConfigured } from './warehouse.js';

const typeByExtension = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  }
  try { return data ? JSON.parse(data) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON request body'), { status: 400 }); }
}

function hashWebDirectory(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (location) => {
    for (const entry of fs.readdirSync(location, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(location, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        hash.update(path.relative(dir, filename));
        hash.update(fs.readFileSync(filename));
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

function staticFile(req, res, pathname, webHash) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const clean = pathname === '/' ? '/index.html' : pathname === '/bust' ? '/bust.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return false; }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) return false;
  const filename = path.resolve(config.webDir, `.${decoded}`);
  if (!filename.startsWith(config.webDir + path.sep)) return false;
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return false;
  const contentType = typeByExtension[path.extname(filename)];
  if (!contentType) return false;
  const isWorker = decoded === '/sw.js';
  const body = isWorker
    ? Buffer.from(fs.readFileSync(filename, 'utf8').replaceAll('__BUILD_VERSION__', webHash))
    : fs.readFileSync(filename);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': isWorker || decoded === '/bust.html' ? 'no-cache, no-store, must-revalidate' : 'no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
    ...(isWorker ? { 'service-worker-allowed': '/' } : {}),
    ...(decoded === '/bust.html' ? { 'clear-site-data': '"cache"' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}

function requestedMode(mode) {
  return mode === 'agent' || mode === 'pipeline' ? mode : config.answerMode;
}

function validConversationId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : null;
}

function publicDevice(device) {
  return { id: device.id, label: device.label, created_at: device.created_at, last_seen: device.last_seen };
}

export function createAppServer({ auth = new AuthStore(path.join(config.dataDir, 'auth.sqlite')) } = {}) {
  const webHash = hashWebDirectory(config.webDir);
  let generating = false;

  /**
   * One question, answered over server-sent events: each step the agent takes
   * as it happens, then the answer, then -- for a draft that passed the
   * statement check -- the result of running it. Every question, every
   * statement run and every outcome goes to the audit log.
   */
  async function streamAnswer({ res, device, question, domain, previousSql, mode, conversationId }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Proxies that buffer would hold every step back until the end.
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    // A comment line now and then keeps the tunnel from closing a quiet
    // stream while the model thinks or waits out a rate limit.
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);
    const started = Date.now();
    send('conversation', { conversation_id: conversationId, mode });
    auth.audit(device, 'question', { question, domain, mode, revising: Boolean(previousSql.trim()) }, conversationId);
    try {
      const runSql = warehouseConfigured()
        ? async (sql, options) => {
          const execution = options?.explainOnly ? await explainWarehouseQuery(sql) : await runWarehouseQuery(sql, options);
          auth.audit(device, options?.explainOnly ? 'explain' : 'execute', { source: 'agent', sql, ok: execution.ok, row_count: execution.row_count ?? null, error: execution.error ?? null, ms: execution.ms ?? null }, conversationId);
          return execution;
        }
        : null;
      const result = await answerQuestion({
        question, domain, previousSql, mode, runSql,
        history: auth.conversationTurns(device.id, conversationId),
        onEvent: (event) => send(event.type, event),
      });
      if (result.status === 'error') {
        auth.audit(device, 'error', { code: result.code }, conversationId);
        send('error', { error: result.code, message: result.message });
        return;
      }
      send('answer', result);
      if (result.status === 'draft' && result.checks?.statement === 'passed' && warehouseConfigured()) {
        send('executing', {});
        const execution = await runWarehouseQuery(result.sql);
        auth.audit(device, 'execute', { source: 'answer', sql: result.sql, ok: execution.ok, row_count: execution.row_count ?? null, error: execution.error ?? null, ms: execution.ms ?? null }, conversationId);
        // Kept with the answer, a page of it: history is for finding a
        // query again, not a copy of the warehouse.
        result.execution = { ...execution, rows: execution.rows?.slice(0, 50) };
        result.checks = checksAfterExecution(result.checks, execution);
        send('execution', execution);
        send('checks', result.checks);
      }
      let historyId = null;
      try { historyId = auth.saveHistory(device.id, question, domain, result, conversationId); }
      catch (error) { console.error(`Could not save query history: ${error.message}`); }
      auth.audit(device, 'answer', {
        status: result.status, mode: result.mode, model: result.model, sql: result.sql, sources: result.sources,
        steps: result.agent_trace?.map(({ tool, summary }) => `${tool}: ${summary}`) ?? null,
        usage: result.usage ?? null, ms: Date.now() - started, history_id: historyId,
      }, conversationId);
      send('saved', { history_id: historyId, conversation_id: conversationId });
    } catch (error) {
      console.error(`/api/ask: ${error.message}`);
      auth.audit(device, 'error', { code: error.publicCode || 'service_unavailable', message: String(error.message).slice(0, 300) }, conversationId);
      send('error', { error: error.publicCode || 'service_unavailable', message: error.publicMessage || 'The service is temporarily unavailable.' });
    } finally {
      clearInterval(heartbeat);
      send('done', {});
      res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local.invalid');
    const pathname = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return json(res, 403, { error: 'wrong_origin' });
    }
    try {
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });

      if (pathname === '/api/auth/session' && req.method === 'GET') {
        const device = auth.deviceForToken(tokenFromCookie(req.headers.cookie));
        return json(res, 200, { authenticated: Boolean(device), device: device ? publicDevice(device) : null });
      }
      if (pathname === '/api/auth/redeem' && req.method === 'POST') {
        const body = await readJson(req);
        const result = auth.redeemInvite(body.code, body.label);
        if (result.error) return json(res, result.error === 'throttled' ? 429 : 400, { error: result.error });
        return json(res, 200, { authenticated: true, device: { id: result.device_id, label: result.label } },
          { 'set-cookie': cookieForToken(result.token, config.cookieSecure) });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        return json(res, 200, { authenticated: false }, { 'set-cookie': clearCookie(config.cookieSecure) });
      }

      if (pathname.startsWith('/api/admin/')) {
        if (!constantTimeTokenMatch(req.headers['x-admin-token'], config.adminToken)) return json(res, 404, { error: 'not_found' });
        if (pathname === '/api/admin/devices' && req.method === 'GET') return json(res, 200, auth.listDevices());
        if (pathname === '/api/admin/invites' && req.method === 'GET') return json(res, 200, auth.listInvites());
        if (pathname === '/api/admin/audit' && req.method === 'GET') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const before = Number(url.searchParams.get('before')) || null;
          return json(res, 200, auth.listAudit(limit, before));
        }
        if (pathname === '/api/admin/invites' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 201, auth.createInvite(body.label, config.publicBaseUrl));
        }
        const deviceAction = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]+)\/(revoke|label)$/);
        if (deviceAction && req.method === 'POST') {
          const body = await readJson(req);
          const changed = deviceAction[2] === 'revoke'
            ? auth.setDeviceRevoked(deviceAction[1], Boolean(body.revoked))
            : auth.setDeviceLabel(deviceAction[1], body.label || 'Device');
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const deleteDevice = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]+)$/);
        if (deleteDevice && req.method === 'DELETE') {
          const changed = auth.deleteDevice(deleteDevice[1]);
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const revokeInvite = pathname.match(/^\/api\/admin\/invites\/(\d+)\/revoke$/);
        if (revokeInvite && req.method === 'POST') {
          const changed = auth.revokeInvite(Number(revokeInvite[1]));
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        return json(res, 404, { error: 'not_found' });
      }

      if (pathname.startsWith('/api/')) {
        const device = auth.deviceForToken(tokenFromCookie(req.headers.cookie));
        if (!device) return json(res, 401, { error: 'not_registered', message: 'Enter an invite code to use this device.' });
        if (pathname === '/api/status' && req.method === 'GET') {
          return json(res, 200, { elasticsearch: await elasticHealth(), model_configured: Boolean(config.modelApiKey), model: config.modelName, answer_mode: config.answerMode, warehouse_configured: warehouseConfigured(), tables: tables.length, metadata_status: DOCUMENT_STATUS });
        }
        if (pathname === '/api/domains' && req.method === 'GET') return json(res, 200, { domains });
        if (pathname === '/api/bench' && req.method === 'GET') {
          // The daemon reads the checkout, so a run just finished is there at
          // once; the files in the image are the fallback.
          if (benchAvailable()) {
            const live = await benchRequest('GET', '/results');
            if (live.status === 200) return json(res, 200, live.body);
          }
          return json(res, 200, loadBenchResults(config.appDir));
        }
        if (pathname === '/api/bench/runner' && req.method === 'GET') {
          if (!benchAvailable()) return json(res, 200, { available: false, allowed: false, device_id: device.id });
          const status = await benchRequest('GET', '/status');
          return json(res, 200, { available: status.status === 200, allowed: mayRunBench(device), device_id: device.id, ...(status.status === 200 ? status.body : {}) });
        }
        if (pathname.startsWith('/api/bench/')) {
          if (!benchAvailable()) return json(res, 503, { error: 'bench_unavailable', message: 'Running tests is not set up on this server.' });
          if (!mayRunBench(device)) return json(res, 403, { error: 'not_allowed', message: 'This device may view results but not start runs.' });
          const routes = { 'GET /api/bench/gpus': '/gpus', 'POST /api/bench/validate': '/validate', 'POST /api/bench/runs': '/runs', 'GET /api/bench/runs/current': '/runs/current', 'POST /api/bench/runs/cancel': '/runs/cancel' };
          const target = routes[`${req.method} ${pathname}`];
          if (!target) return json(res, 404, { error: 'not_found' });
          let body;
          if (req.method === 'POST') {
            const input = await readJson(req);
            body = target === '/runs'
              ? { model: String(input.model ?? ''), gpu: String(input.gpu ?? ''), mode: String(input.mode ?? ''), names: String(input.names ?? 'cryptic'), provider: input.provider === 'openrouter' ? 'openrouter' : 'runpod', requested_by: device.label }
              : target === '/validate' ? { model: String(input.model ?? ''), provider: input.provider === 'openrouter' ? 'openrouter' : 'runpod' } : {};
          }
          const reply = await benchRequest(req.method, target, body);
          return json(res, reply.status, reply.body);
        }
        if (pathname === '/api/history' && req.method === 'GET') {
          const limitText = url.searchParams.get('limit') || '20';
          const beforeText = url.searchParams.get('before');
          const limit = Number(limitText);
          const before = beforeText === null ? null : Number(beforeText);
          if (!/^\d+$/.test(limitText) || limit < 1 || limit > 50
              || (beforeText !== null && (!/^\d+$/.test(beforeText) || !Number.isSafeInteger(before) || before < 1))) {
            return json(res, 400, { error: 'invalid_history_page' });
          }
          return json(res, 200, auth.listHistory(device.id, limit, before));
        }
        const historyEntry = pathname.match(/^\/api\/history\/(\d+)$/);
        if (historyEntry && (req.method === 'GET' || req.method === 'DELETE')) {
          const id = Number(historyEntry[1]);
          if (!Number.isSafeInteger(id) || id < 1) return json(res, 400, { error: 'invalid_history_id' });
          if (req.method === 'GET') {
            const entry = auth.getHistory(device.id, id);
            return json(res, entry ? 200 : 404, entry || { error: 'not_found' });
          }
          const deleted = auth.deleteHistory(device.id, id);
          return json(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not_found' });
        }
        if (pathname === '/api/search' && req.method === 'GET') {
          const question = (url.searchParams.get('q') || '').trim();
          const domain = url.searchParams.get('domain') || 'all';
          if (question.length < 2 || question.length > 1000 || (domain !== 'all' && !domains.includes(domain))) return json(res, 400, { error: 'invalid_search' });
          return json(res, 200, { tables: await searchTables(question, domain), metadata_status: DOCUMENT_STATUS });
        }
        if (pathname === '/api/check' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 200, { checks: checkSql(body.sql) });
        }
        if (pathname === '/api/execute' && req.method === 'POST') {
          const body = await readJson(req);
          const sql = String(body.sql || '');
          const conversationId = validConversationId(body.conversation_id);
          if (!sql.trim() || sql.length > 20_000) return json(res, 400, { error: 'invalid_request' });
          if (!warehouseConfigured()) return json(res, 503, { error: 'warehouse_unconfigured', message: 'No warehouse is configured on this server.' });
          const execution = await runWarehouseQuery(sql);
          auth.audit(device, 'execute', { source: 'user', sql, ok: execution.ok, row_count: execution.row_count ?? null, error: execution.error ?? null, ms: execution.ms ?? null }, conversationId);
          return json(res, 200, { execution, checks: checksAfterExecution(checkSql(sql), execution) });
        }
        if (pathname === '/api/ask' && req.method === 'POST') {
          const body = await readJson(req);
          const question = String(body.question || '').trim();
          const domain = String(body.domain || 'all');
          const previousSql = String(body.previous_sql || '');
          const mode = requestedMode(body.mode);
          if (question.length < 2 || question.length > 1000 || previousSql.length > 20_000 || (domain !== 'all' && !domains.includes(domain))) return json(res, 400, { error: 'invalid_request' });
          if (body.conversation_id && !validConversationId(body.conversation_id)) return json(res, 400, { error: 'invalid_conversation' });
          if (generating) return json(res, 429, { error: 'busy', message: 'A draft is already being generated. Try again shortly.' });
          generating = true;
          return streamAnswer({ res, device, question, domain, previousSql, mode, conversationId: body.conversation_id || crypto.randomUUID() })
            .finally(() => { generating = false; });
        }
        if (pathname === '/api/generate' && req.method === 'POST') {
          const body = await readJson(req);
          const question = String(body.question || '').trim();
          const domain = String(body.domain || 'all');
          const previousSql = String(body.previous_sql || '');
          if (question.length < 5 || question.length > 1000 || previousSql.length > 20_000 || (domain !== 'all' && !domains.includes(domain))) return json(res, 400, { error: 'invalid_request' });
          if (generating) return json(res, 429, { error: 'busy', message: 'A draft is already being generated. Try again shortly.' });
          generating = true;
          try {
            const result = await answerQuestion({ question, domain, previousSql, mode: requestedMode(body.mode) });
            if (result.status === 'error') return json(res, 503, result);
            let historyId = null;
            try { historyId = auth.saveHistory(device.id, question, domain, result); }
            catch (error) { console.error(`Could not save query history: ${error.message}`); }
            return json(res, 200, { ...result, history_id: historyId, history_saved: historyId !== null });
          } finally { generating = false; }
        }
        return json(res, 404, { error: 'not_found' });
      }

      if (staticFile(req, res, pathname, webHash)) return;
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      const status = error.status || 503;
      console.error(`${req.method} ${pathname}: ${error.message}`);
      return json(res, status, { error: error.publicCode || (status === 503 ? 'service_unavailable' : 'request_error'), message: error.publicMessage || (status === 503 ? 'The service is temporarily unavailable.' : error.message) });
    }
  });
  server.on('close', () => auth.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createAppServer();
  server.listen(config.port, config.host, () => console.log(`SQL assistant listening on ${config.host}:${config.port}`));
}

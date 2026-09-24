import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore, clearCookie, constantTimeTokenMatch, cookieForToken, tokenFromCookie } from './auth.js';
import { config } from './config.js';
import { domains, tables } from './catalog.js';
import { elasticHealth, searchTables } from './elastic.js';
import { generateDraft } from './model.js';
import { checkSql } from './sql-check.js';

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
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}

function publicDevice(device) {
  return { id: device.id, label: device.label, created_at: device.created_at, last_seen: device.last_seen };
}

export function createAppServer({ auth = new AuthStore(path.join(config.dataDir, 'auth.sqlite')) } = {}) {
  const webHash = hashWebDirectory(config.webDir);
  let generating = false;
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
          return json(res, 200, { elasticsearch: await elasticHealth(), model_configured: Boolean(config.modelApiKey), model: config.modelName, tables: tables.length, metadata_status: 'synthetic_fixture' });
        }
        if (pathname === '/api/domains' && req.method === 'GET') return json(res, 200, { domains });
        if (pathname === '/api/search' && req.method === 'GET') {
          const question = (url.searchParams.get('q') || '').trim();
          const domain = url.searchParams.get('domain') || 'all';
          if (question.length < 2 || question.length > 1000 || (domain !== 'all' && !domains.includes(domain))) return json(res, 400, { error: 'invalid_search' });
          return json(res, 200, { tables: await searchTables(question, domain), metadata_status: 'synthetic_fixture' });
        }
        if (pathname === '/api/check' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 200, { checks: checkSql(body.sql) });
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
            const hits = await searchTables(question, domain);
            const result = await generateDraft({ question, previousSql, hits });
            return json(res, result.status === 'error' ? 503 : 200, result);
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

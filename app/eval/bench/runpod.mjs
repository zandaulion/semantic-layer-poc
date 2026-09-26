/**
 * The little of RunPod's REST API the benchmark needs: price a card, rent a
 * pod, wait for its server, read its log, delete it.
 *
 * The API key is read from RUNPOD_API_KEY or from ~/.config/runpod-api-key and
 * is only ever sent in an Authorization header. Every pod this creates is
 * written to a ledger first, so a run that dies half way leaves a record of
 * what to delete, and `bench.mjs --cleanup` deletes exactly those pods and no
 * others.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { isAmpere } from './validate.mjs';

const API = 'https://api.runpod.io/v2';

export async function apiKey() {
  if (process.env.RUNPOD_API_KEY) return process.env.RUNPOD_API_KEY.trim();
  try {
    return (await readFile(path.join(homedir(), '.config', 'runpod-api-key'), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function call(method, route, body) {
  const key = await apiKey();
  if (!key) throw new Error('No RunPod API key: set RUNPOD_API_KEY or write it to ~/.config/runpod-api-key (mode 600).');
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 300) }; }
  if (!response.ok) {
    const error = new Error(`RunPod ${method} ${route}: ${response.status} ${payload?.message ?? payload?.error ?? text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * Cards the benchmark can rent: NVIDIA (the vLLM image is CUDA), whole cards
 * rather than MIG slices, with a Secure Cloud price, 24 GB or more.
 */
export async function listGpus() {
  // Stock counted only on hosts new enough for the vLLM image (CUDA 12.8), the
  // same constraint every pod is created with: otherwise a card shows stock
  // that a create then refuses.
  const { gpus } = await call('GET', '/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&minCudaVersion=12.8');
  return gpus
    .filter((g) => g.secure && g.manufacturer !== 'AMD' && !/MIG/.test(g.id) && g.memory >= 24 && g.price?.secure > 0)
    .map((g) => ({ id: g.id, name: g.name ?? g.id, memory_gb: g.memory, price: g.price.secure, stock: g.availability ?? 'NONE', ampere: isAmpere(g.name ?? g.id) }))
    .sort((a, b) => a.price - b.price);
}

/** What RunPod has billed today, all resources. It lags by up to a few hours. */
export async function billedToday() {
  const billing = await call('GET', '/billing?bucketSize=day&lastN=1');
  return billing?.metadata?.totals?.totalAmount ?? 0;
}

export async function gpuPrice(gpuId, cloud) {
  const gpu = await call('GET', `/catalog/gpus/${encodeURIComponent(gpuId)}`);
  return gpu.price?.[cloud === 'COMMUNITY' ? 'community' : 'secure'] ?? null;
}

// ------------------------------------------------------------------ ledger

export function ledger(cacheDir) {
  const file = path.join(cacheDir, 'pods.json');
  const load = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
  };
  const save = async (pods) => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, `${JSON.stringify(pods, null, 2)}\n`);
  };
  return {
    load,
    async add(pod) { await save([...(await load()), pod]); },
    async remove(id) { await save((await load()).filter((p) => p.id !== id)); },
  };
}

// -------------------------------------------------------------------- pods

/**
 * Rents the first card in `cards` that has stock. A capacity refusal moves on
 * to the next card; any other error stops, because it will not go away by
 * asking for different hardware.
 */
export async function createPod({ name, cards, cloud, image, cmd, env, disk, minCuda }) {
  const refusals = [];
  for (const card of cards) {
    // The catalog says when a card is out of stock, which is cheaper and
    // clearer than reading it out of a refused create.
    const stock = await call('GET', `/catalog/gpus/${encodeURIComponent(card)}?include=AVAILABILITY&product=POD&cloud=${cloud}${minCuda ? `&minCudaVersion=${minCuda}` : ''}`).catch(() => null);
    if (stock?.availability === 'NONE') { refusals.push(`${card}: none in stock`); continue; }
    try {
      const pod = await call('POST', '/pods', {
        name, cloud, image, cmd, env, disk, ports: ['8000/http'],
        gpu: { id: card, count: 1, ...(minCuda ? { minCudaVersion: minCuda } : {}) },
      });
      return { pod, card, refusals };
    } catch (error) {
      const capacity = error.status >= 500
        || /capacity|availab|stock|no .*machine|instances|resources|could not find/i.test(error.message);
      if (!capacity) throw error;
      refusals.push(`${card}: ${error.message.replace(/^RunPod [^:]+: /, '')}`);
    }
  }
  const error = new Error(`No card available: ${refusals.join('; ')}`);
  error.refusals = refusals;
  throw error;
}

export const getPod = (id) => call('GET', `/pods/${id}`);
export const deletePod = (id) => call('DELETE', `/pods/${id}`);

/** The last lines of a pod's container log, for when its server never answers. */
export async function podLog(id, lines = 25, source = 'container') {
  const key = await apiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let text = '';
  try {
    const response = await fetch(`${API}/pods/${id}/logs?source=${source}&tail=${lines}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, signal: controller.signal,
    });
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
  } catch { /* the stream is cut off on purpose */ } finally {
    clearTimeout(timer);
  }
  return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => {
    try { return JSON.parse(l.slice(5)).line ?? l.slice(5); } catch { return l.slice(5); }
  }).slice(-lines);
}

/**
 * Waits until the server on the pod answers /v1/models with the model loaded.
 * Fails early if the pod itself stops.
 */
/**
 * The exception that started a failed start-up. vLLM's last lines are
 * wrappers -- "Engine core initialization failed", a pydantic "failed to be
 * inspected" -- and the cause is the first real exception above them.
 */
function rootCause(lines) {
  const clean = lines.map((l) => l.replace(/^\([A-Za-z]+ pid=\d+\)\s*(?:ERROR [^\]]*\] )?/, '').trim());
  const exception = /^(?:[\w.]*(?:Error|Exception)|torch\.OutOfMemoryError|AssertionError)\b[:(]?/;
  const wrapper = /Engine core initialization failed|failed to be inspected|See root cause above|errors\.pydantic\.dev/;
  const real = clean.filter((l) => exception.test(l) && !wrapper.test(l));
  const chosen = real.length ? real.slice(0, 2) : clean.filter((l) => /error/i.test(l)).slice(-2);
  return [...new Set(chosen)].join(' | ').slice(0, 600) || 'no error line found in the log';
}

const FATAL = /Engine core initialization failed|EngineCore failed to start|CUDA out of memory|OutOfMemoryError|vllm serve: error|error: argument|error: unrecognized arguments/;

export async function waitForServer({ id, apiKey: serverKey, model, deadline, onTick }) {
  const url = `https://${id}-8000.proxy.runpod.net/v1/models`;
  let lastStatus = null;
  for (let i = 0; ; i++) {
    if (Date.now() > deadline) throw new Error(`The server did not answer before the deadline (last pod status ${lastStatus}).`);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${serverKey}` }, signal: AbortSignal.timeout(10_000) });
      if (response.ok && (await response.text()).includes(model)) return `https://${id}-8000.proxy.runpod.net/v1`;
    } catch { /* not up yet */ }
    if (i % 6 === 0) {
      const pod = await getPod(id).catch(() => null);
      lastStatus = pod?.status ?? lastStatus;
      if (['EXITED', 'ERROR', 'TERMINATED'].includes(pod?.status)) throw new Error(`The pod stopped (${pod.status}) before its server answered.`);
      // A server that fails to start is restarted by the pod over and over
      // while the pod itself reports RUNNING. Its log says so at once; waiting
      // out the deadline would only pay for the retries.
      if (i > 0) {
        const tail = await podLog(id, 300).catch(() => []);
        // The pod restarts a container that exits, so a server that cannot
        // start shows up as the same start line, again and again.
        const system = await podLog(id, 40, 'system').catch(() => []);
        const starts = system.filter((l) => /start container/.test(l)).length;
        if (starts >= 4) {
          // With nothing in the container's log, the container died before
          // vLLM could say anything: the cause is the host's, and only the
          // pod's system log has it.
          const hostSide = system.filter((l) => !/start container|create container|Pulling|Digest|Status: Image/i.test(l));
          const reason = tail.length ? rootCause(tail)
            : `the container exited before vLLM wrote anything, so the cause is on the host. Pod system log: ${hostSide.slice(-4).join(' | ').slice(0, 500) || '(nothing beyond container starts)'}`;
          const error = new Error(`vLLM keeps restarting (${starts} starts): ${reason}`);
          error.logs = { container: tail.slice(-40), system: system.slice(-40) };
          throw error;
        }
        if (tail.some((l) => FATAL.test(l))) {
          const error = new Error(`vLLM failed to start: ${rootCause(tail)}`);
          error.logs = { container: tail.slice(-40), system: system.slice(-40) };
          error.logged = true;
          throw error;
        }
      }
    }
    await onTick?.();
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

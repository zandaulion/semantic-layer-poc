#!/usr/bin/env node
/**
 * Runs benchmarks on request from the PWA.
 *
 * The PWA lives in a container with no podman and no RunPod key, and should
 * keep it that way. This process runs on the host and holds both. The two talk
 * through files in a directory mounted into the PWA's container: the PWA
 * writes a request to requests/, this answers in responses/. No port, so
 * nothing on the network can reach it; and not a unix socket, because SELinux
 * rightly refuses a container a connection to a socket owned by a host
 * process, while a relabelled directory is exactly what it allows. The PWA
 * decides which registered devices may ask.
 *
 * It starts bench.mjs, one run at a time, and refuses a run that would take
 * the day's spend past a cap (BENCH_DAILY_CAP_USD, default 5).
 *
 *   node eval/bench/daemon.mjs            # directory: BENCH_DIR or ~/.local/share/banking-bench
 */

import { spawn } from 'node:child_process';
import { readFileSync, watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBenchResults } from '../../server/bench-results.js';
import { apiKey, billedToday, listGpus } from './runpod.mjs';
import { fits, validateModel } from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..');
const cacheDir = path.join(here, '.cache');
const exchange = process.env.BENCH_DIR || path.join(homedir(), '.local', 'share', 'banking-bench');
const dailyCap = Number(process.env.BENCH_DAILY_CAP_USD || 5);
// What a run is allowed to cost in time, and so at most in money.
const LIMIT_MINUTES = { quick: 15, full: 25 };
// What a run usually takes, for the estimate shown before it starts.
const TYPICAL_MINUTES = { quick: 8, full: 12 };

// ------------------------------------------------------------------ spend

const spendFile = path.join(cacheDir, 'spend.json');
const today = () => new Date().toISOString().slice(0, 10);
async function spend() {
  try { return JSON.parse(await readFile(spendFile, 'utf8')); } catch { return {}; }
}
// Today's spend, for the cap: this daemon's own ledger or RunPod's bill,
// whichever is higher. The bill includes pods started elsewhere, but lags; the
// ledger is immediate, but knows only its own runs.
let billed = { at: 0, usd: 0 };
async function spentToday() {
  if (Date.now() - billed.at > 300_000) {
    billed = { at: Date.now(), usd: await billedToday().catch(() => billed.usd) };
  }
  return Math.round(Math.max((await spend())[today()] ?? 0, billed.usd) * 100) / 100;
}

async function addSpend(usd) {
  const ledger = await spend();
  ledger[today()] = Math.round(((ledger[today()] ?? 0) + usd) * 100) / 100;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(spendFile, `${JSON.stringify(ledger, null, 2)}\n`);
}

// ----------------------------------------------------------------- the GPUs

let gpuCache = { at: 0, list: [] };
async function gpus() {
  if (Date.now() - gpuCache.at > 60_000) gpuCache = { at: Date.now(), list: await listGpus() };
  return gpuCache.list;
}

// ------------------------------------------------------------------- runs

let current = null; // the run in progress, or the last one

// bench.mjs rewrites the log at the start of each run, headed by the time it
// started. Until this run's header is there, the file still holds the last run.
function progressLog(since) {
  try {
    const lines = readFileSync(path.join(cacheDir, 'progress.log'), 'utf8').split('\n').filter(Boolean);
    const started = lines[0]?.match(/^# (\S+)/)?.[1];
    return started && started >= since ? lines : [];
  } catch {
    return [];
  }
}

function view(run) {
  if (!run) return null;
  const lines = progressLog(run.started_at).filter((l) => !l.startsWith('#'));
  const phases = lines.map((l) => l.match(/^\[[\d:]+\] \[(\d+)\/(\d+)\] (.*)$/)).filter(Boolean)
    .map((m) => ({ step: Number(m[1]), of: Number(m[2]), text: m[3] }));
  const lastProgress = [...lines].reverse().find((l) => /^\[[\d:]+\] {3}/.test(l));
  const answered = lastProgress?.match(/(\d+)\/(\d+) answered/);
  return {
    id: run.id, model: run.model, gpu: run.gpu, gpu_name: run.gpu_name, price: run.price, mode: run.mode,
    requested_by: run.requested_by, status: run.status, started_at: run.started_at, finished_at: run.finished_at ?? null,
    elapsed_s: Math.round(((run.finished_ms ?? Date.now()) - run.started_ms) / 1000),
    phase: phases.at(-1) ?? null,
    phases,
    progress: lastProgress ? lastProgress.replace(/^\[[\d:]+\] {3}/, '').replace(/^\[[#.]+\] /, '') : null,
    answered: answered ? { done: Number(answered[1]), total: Number(answered[2]) } : null,
    log: lines.filter((l) => !/^\[[\d:]+\] {3}\[/.test(l)).slice(-10),
    cost_usd: run.cost_usd ?? null,
    error: run.error ?? null,
    result: run.result ?? null,
  };
}

async function startRun({ model: name, gpu: gpuId, mode, requested_by: requestedBy }) {
  if (current?.status === 'running') return { status: 409, body: { error: 'busy', message: `A run is already going: ${current.model} on ${current.gpu_name}.` } };
  if (!['quick', 'full'].includes(mode)) return { status: 400, body: { error: 'bad_mode', message: 'Choose quick or full.' } };
  if (!(await apiKey())) return { status: 503, body: { error: 'no_key', message: 'The host has no RunPod API key.' } };

  // Everything is checked again here, whatever the page already showed:
  // this is the last point before money is spent.
  const model = await validateModel(name);
  if (!model.ok) return { status: 400, body: { error: 'bad_model', message: model.reason } };
  const gpu = (await gpus()).find((g) => g.id === gpuId);
  if (!gpu) return { status: 400, body: { error: 'bad_gpu', message: 'That card is not on the list.' } };
  if (gpu.stock === 'NONE') return { status: 409, body: { error: 'no_stock', message: `${gpu.name} has no stock right now. Choose another card.` } };
  if (!fits(model, gpu.memory_gb)) return { status: 400, body: { error: 'too_small', message: `${model.model} needs about ${model.need_gb} GB; ${gpu.name} has ${gpu.memory_gb} GB.` } };
  const worst = Math.round((gpu.price * LIMIT_MINUTES[mode]) / 60 * 100) / 100;
  const spent = await spentToday();
  if (spent + worst > dailyCap) {
    return { status: 402, body: { error: 'cap', message: `Today's runs have cost $${spent.toFixed(2)}; this one could cost up to $${worst.toFixed(2)}, past the daily cap of $${dailyCap.toFixed(2)}.` } };
  }

  const args = [path.join(here, 'bench.mjs')];
  if (model.profile) args.push('--model', model.profile);
  else args.push('--hf', model.model, '--disk', String(Math.ceil(model.weights_gb * 2 + 30)));
  args.push('--card', gpu.id, '--max-minutes', String(LIMIT_MINUTES[mode]));
  if (mode === 'quick') args.push('--quick');

  const run = {
    id: `run-${Date.now()}`, model: model.model, profile: model.profile, gpu: gpu.id, gpu_name: gpu.name, price: gpu.price, mode,
    requested_by: requestedBy ?? null, status: 'running', started_at: new Date().toISOString(), started_ms: Date.now(),
  };
  const child = spawn(process.execPath, args, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  run.child = child;
  let output = '';
  const take = (chunk) => { output = (output + chunk).slice(-20_000); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('close', async (code, signal) => {
    run.finished_ms = Date.now();
    run.finished_at = new Date().toISOString();
    const podSeconds = Number(output.match(/deleted pod \S+ after (\d+) s/)?.[1] ?? 0);
    run.cost_usd = podSeconds ? Math.round((gpu.price * podSeconds) / 36) / 100 : 0;
    if (run.cost_usd) await addSpend(run.cost_usd).catch(() => {});
    const wrote = output.match(/wrote (\S+\.json)/)?.[1];
    if (wrote) {
      try {
        const result = JSON.parse(await readFile(path.resolve(appDir, wrote), 'utf8'));
        run.result = { file: path.basename(wrote), quick: result.quick, stopped_early: result.stopped_early ?? null, summary: result.summary, throughput_qpm: result.throughput_qpm, minutes: Math.round(result.timings.total_s / 6) / 10 };
      } catch { /* the run still happened */ }
    }
    run.status = run.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
    if (run.status === 'failed') {
      const reason = output.match(/bench failed: ([^\n]+)/)?.[1] ?? `bench exited with ${code ?? signal}`;
      // RunPod's stock moves by the minute, so a card listed a moment ago can
      // be gone by the time it is asked for. Say that plainly.
      run.error = /^No card available/.test(reason)
        ? `RunPod had no ${gpu.name} to rent after all: its stock changes by the minute. Nothing was charged. Choose another card and start again.`
        : reason;
      gpuCache.at = 0;
    }
    delete run.child;
  });
  current = run;
  return { status: 202, body: view(run) };
}

function cancelRun() {
  if (current?.status !== 'running') return { status: 409, body: { error: 'idle', message: 'No run is going.' } };
  current.cancelled = true;
  // SIGINT is bench.mjs's Ctrl-C: it deletes the pod before it exits.
  current.child.kill('SIGINT');
  return { status: 202, body: view(current) };
}

// ---------------------------------------------------------------- exchange

const routes = {
  'GET /status': async () => ({ status: 200, body: { ok: true, key: Boolean(await apiKey()), running: current?.status === 'running', spent_today: await spentToday(), daily_cap: dailyCap, typical_minutes: TYPICAL_MINUTES, limit_minutes: LIMIT_MINUTES } }),
  'GET /gpus': async () => ({ status: 200, body: { gpus: await gpus() } }),
  'POST /validate': async (body) => ({ status: 200, body: await validateModel(body.model) }),
  'POST /runs': async (body) => startRun(body),
  'GET /runs/current': async () => ({ status: 200, body: { run: view(current) } }),
  'POST /runs/cancel': async () => cancelRun(),
  'GET /results': async () => ({ status: 200, body: loadBenchResults(appDir) }),
};

const requests = path.join(exchange, 'requests');
const responses = path.join(exchange, 'responses');
const ID = /^[0-9a-f-]{36}\.json$/;
const busy = new Set();

async function answer(file) {
  if (busy.has(file)) return;
  busy.add(file);
  // The watcher and the sweep can both see one request; whichever comes
  // second finds it already answered and removed, and leaves it alone.
  const text = await readFile(path.join(requests, file), 'utf8').catch(() => null);
  if (text === null) { busy.delete(file); return; }
  let reply;
  try {
    const request = JSON.parse(text);
    const route = routes[`${request.method} ${request.path}`];
    reply = route ? await route(request.body ?? {}) : { status: 404, body: { error: 'not_found' } };
  } catch (error) {
    reply = { status: 500, body: { error: 'daemon_error', message: String(error.message).slice(0, 300) } };
  }
  // Written aside and renamed, so the PWA never reads half an answer.
  const temporary = path.join(responses, `.${file}`);
  await writeFile(temporary, JSON.stringify(reply));
  await rename(temporary, path.join(responses, file));
  await rm(path.join(requests, file), { force: true });
  busy.delete(file);
}

async function sweep() {
  const files = await readdir(requests).catch(() => []);
  for (const file of files.filter((f) => ID.test(f))) answer(file);
  // Answers nobody collected, from a request that timed out on the PWA's side.
  for (const file of await readdir(responses).catch(() => [])) {
    const info = await stat(path.join(responses, file)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 120_000) await rm(path.join(responses, file), { force: true });
  }
}

await mkdir(requests, { recursive: true });
await mkdir(responses, { recursive: true });
watch(requests, (event, file) => { if (file && ID.test(file)) answer(file); });
setInterval(sweep, 1000);
sweep();
console.log(`bench daemon answering in ${exchange}; daily cap $${dailyCap}`);

// A run in progress owns a pod. Stopping the daemon stops the run the way
// Ctrl-C would, so the pod is deleted rather than left running.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (current?.status === 'running') {
      current.child.once('close', () => process.exit(0));
      current.child.kill('SIGINT');
    } else process.exit(0);
  });
}

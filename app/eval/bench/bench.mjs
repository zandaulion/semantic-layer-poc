#!/usr/bin/env node
/**
 * Benchmarks one model end to end: rents a GPU, serves the model with vLLM,
 * runs the benchmark questions through the real pipeline, scores the drafts by
 * running them, deletes the GPU, and prints the result next to every earlier
 * run.
 *
 *   node eval/bench/bench.mjs --model gpt-oss-20b          # a profile in models/
 *   node eval/bench/bench.mjs --model qwen3.8-27b --card "NVIDIA A100-SXM4-80GB"
 *   node eval/bench/bench.mjs --hf org/name --card "NVIDIA L40S"   # no profile
 *   node eval/bench/bench.mjs --model gpt-oss-20b --dry-run
 *   node eval/bench/bench.mjs --endpoint URL --served-name NAME --key-file F   # a server you already run
 *   node eval/bench/bench.mjs --report                     # the table of all runs
 *   node eval/bench/bench.mjs --cleanup                    # delete pods a failed run left behind
 *
 * Runs on the host that runs the POC: it needs podman, the banking-dwh network
 * and its Elasticsearch, and a RunPod API key (see runpod.mjs).
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ensureDatabase, stopDatabase } from './pg.mjs';
import { scoreDrafts, summarise } from './score.mjs';
import { apiKey, createPod, deletePod, gpuPrice, ledger, podLog, waitForServer } from './runpod.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..');
const projectDir = path.dirname(appDir);
const cacheDir = path.join(here, '.cache');
const resultsDir = path.join(here, 'results');
const IMAGE = 'vllm/vllm-openai:v0.30.0';
const RUNNER_IMAGE = 'docker.io/library/node:24-alpine';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const has = (name) => argv.includes(name);

const t0 = Date.now();
const clock = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
// On a terminal, progress rewrites one line; in a log file, it prints a new
// line when the text changes, at most every 20 seconds.
const tty = process.stdout.isTTY;
// Every run also writes its progress to one fixed file, so it can be
// followed with `tail -f` from another terminal whoever started it.
const logFile = path.join(cacheDir, 'progress.log');
const toLog = (line) => { try { appendFileSync(logFile, `${line}\n`); } catch { /* the cache may not exist yet */ } };
let shown = { text: '', at: 0 };
const endProgress = () => { if (tty && shown.text) process.stdout.write('\n'); shown = { text: '', at: 0 }; };
const say = (text) => { endProgress(); console.log(`[${clock()}] ${text}`); toLog(`[${clock()}] ${text}`); };
const progress = (text) => {
  if (text !== shown.logged) { toLog(`[${clock()}]   ${text}`); shown.logged = text; }
  if (tty) { process.stdout.write(`\r\x1b[K[${clock()}]   ${text}`); shown = { ...shown, text, at: Date.now() }; return; }
  if (text === shown.text || Date.now() - shown.at < 20_000) return;
  console.log(`[${clock()}]   ${text}`);
  shown = { ...shown, text, at: Date.now() };
};
const bar = (done, total, width = 24) => `[${'#'.repeat(Math.round((done / total) * width)).padEnd(width, '.')}]`;
let phaseCount = 0;
const phase = (text) => say(`[${++phaseCount}/${PHASES}] ${text}`);
let PHASES = 6;

/** What vLLM is doing, judged from the last lines of the pod's log. */
function stage(lines, system = []) {
  // The container's own log first: the system log's early "pulling" lines
  // would otherwise outrank a model that is already loading.
  if (!lines.length) return /start container/.test(system.join('\n')) ? 'starting the container' : /Pulling|Downloading|Extracting|pull/i.test(system.join('\n')) ? 'pulling the vLLM image' : 'starting';
  const text = lines.join('\n');
  const last = (re) => [...text.matchAll(re)].at(-1);
  const shards = last(/checkpoint shards:\s+(\d+)%/g);
  if (/Starting vLLM API server|Application startup complete|Uvicorn running/.test(text)) return 'starting the API server';
  if (/CUDA graph|cudagraph|Capturing/i.test(lines.slice(-5).join(' '))) return 'capturing CUDA graphs';
  if (/torch\.compile|Compiling|compile/i.test(lines.slice(-5).join(' '))) return 'compiling';
  if (/KV cache|profiling|warmup/i.test(lines.slice(-5).join(' '))) return 'sizing the KV cache and warming up';
  if (shards) return `loading weights into the GPU, ${shards[1]}%`;
  if (/safetensors|Downloading|Fetching|huggingface|hf_hub/i.test(text)) return 'downloading the weights';
  if (/Pulling|Downloading|Extracting|Waiting|pull/i.test(text)) return 'pulling the vLLM image';
  if (/start container/.test(text)) return 'starting the container';
  return 'starting';
}

// ---------------------------------------------------------------- profiles

async function loadProfile() {
  if (flag('--hf')) {
    const hf = flag('--hf');
    return {
      name: flag('--name', hf.split('/').pop().toLowerCase()), hf, about: 'Ad-hoc run without a profile.',
      cards: [flag('--card', 'NVIDIA A100-SXM4-80GB')], disk_gb: Number(flag('--disk', 150)),
      // --max-num-seqs 64: the benchmark never has more than 32 requests in
      // flight, and hybrid models refuse vLLM's default of 256 on a small card.
      vllm_args: ['--max-model-len', '8192', '--gpu-memory-utilization', '0.9', '--max-num-seqs', '64', '--no-enable-prefix-caching'],
      extra_body: JSON.parse(flag('--extra-body', '{}')),
    };
  }
  const name = flag('--model');
  const file = path.join(here, 'models', `${name}.json`);
  const profile = JSON.parse(await readFile(file, 'utf8').catch(async () => {
    const known = (await readdir(path.join(here, 'models'))).map((f) => f.replace(/\.json$/, ''));
    throw new Error(`No profile "${name}". Known: ${known.join(', ')}. Or pass --hf org/name.`);
  }));
  if (flag('--card')) profile.cards = [flag('--card')];
  // For experiments: extra server arguments without editing the profile, e.g.
  // --vllm-extra '["--attention-backend","FLEX_ATTENTION"]'. The result file
  // records the arguments actually used.
  if (flag('--vllm-extra')) profile.vllm_args = [...profile.vllm_args, ...JSON.parse(flag('--vllm-extra'))];
  if (flag('--image')) profile.image = flag('--image');
  return profile;
}

// ------------------------------------------------------------ the pipeline

async function preflight() {
  const { stdout } = await run('podman', ['ps', '--format', '{{.Names}}']);
  const names = stdout.split('\n');
  for (const needed of ['banking-poc-elasticsearch']) {
    if (!names.includes(needed)) throw new Error(`${needed} is not running; start the POC first.`);
  }
}

/** Runs a script from this checkout in a throwaway container on the POC's network. */
async function inRunner(script, args, env, outDir, onLine) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  // A failed command's message quotes the command line, and with it the
  // server key. Replace the message rather than trust it not to be printed.
  const secrets = Object.values(env).filter((v) => typeof v === 'string' && v.length >= 20 && /^[0-9a-f]+$/.test(v));
  const scrub = (text) => secrets.reduce((t, secret) => t.split(secret).join('<key>'), String(text));
  try {
    return await runner();
  } catch (error) {
    throw new Error(`${script} failed: ${scrub(`${error.stdout ?? ''}${error.stderr ?? ''}`).trim().split('\n').slice(-6).join('\n') || scrub(error.message).split('\n')[0].replace(/podman run .*/, 'podman run ...')}`);
  }
  function runner() {
    return new Promise((resolve, reject) => {
      const child = spawn('podman', [
        'run', '--rm', '--network', 'banking-dwh', '--memory', '768m', '--security-opt', 'label=disable',
        '--volume', `${appDir}:/srv/app:ro`, '--volume', `${path.join(projectDir, 'banking-poc')}:/srv/banking-poc:ro`,
        '--volume', `${outDir}:/out`, '--workdir', '/srv/app',
        '--env', 'ELASTICSEARCH_URL=http://banking-poc-elasticsearch:9200', ...envArgs,
        RUNNER_IMAGE, 'node', script, ...args,
      ]);
      let output = '';
      let partial = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), Number(flag('--runner-minutes', 15)) * 60_000);
      const take = (chunk) => {
        output += chunk;
        partial += chunk;
        const lines = partial.split('\n');
        partial = lines.pop();
        for (const line of lines) onLine?.(line);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(Object.assign(new Error(`exit ${code}`), { stdout: output.split('\n').filter((l) => !l.startsWith('PROGRESS')).join('\n') }));
      });
    });
  }
}

/**
 * Two requests straight to the server before the benchmark: plain text, then
 * a tiny JSON schema. They separate a model that is broken as served from one
 * that only fails under the schema, which the pipeline's errors cannot.
 */
async function probe(baseUrl, key, profile) {
  const ask = async (label, body) => {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        // Room for a reasoning model to think before it answers: at 120 tokens
        // gpt-oss spent the lot reasoning and the long-prompt probe came back
        // empty, which read as a failure that was not there.
        body: JSON.stringify({ model: profile.name, temperature: 0.1, max_tokens: 400, ...body, ...(profile.extra_body ?? {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json();
      const choice = payload.choices?.[0];
      const text = String(choice?.message?.content ?? payload.error?.message ?? payload.message ?? '').replace(/\s+/g, ' ');
      say(`probe, ${label}: ${response.status} ${choice?.finish_reason ?? ''} ${JSON.stringify(text.slice(0, 160))}`);
    } catch (error) {
      say(`probe, ${label}: ${error.message}`);
    }
  };
  await ask('plain text', { messages: [{ role: 'user', content: 'Name three colours of the rainbow, comma separated.' }] });
  // As long as a benchmark prompt, about 3,000 tokens: a model that fails only
  // on long prompts passes the two short probes and fails this one.
  const filler = Array.from({ length: 120 }, (_, i) => `Table t${i} has columns id, name, amount and created_at.`).join(' ');
  await ask('long prompt', { messages: [{ role: 'user', content: `${filler}\n\nIgnoring everything above, name three colours of the rainbow, comma separated.` }] });
  await ask('JSON schema', {
    messages: [{ role: 'user', content: 'What is the capital of France? Reply as JSON.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } },
  });
  await appShapeProbe(baseUrl, key, profile);
}

/**
 * The request the application actually sends, with its schema and fields. A
 * server can accept the probes above and refuse this; when it does, send it
 * again with one difference taken away at a time, and say which removal made
 * it pass. That names the incompatible field in one run instead of one per
 * guess.
 */
async function appShapeProbe(baseUrl, key, profile) {
  const { responseSchema } = await import('../../server/model.js');
  const full = {
    model: profile.name, temperature: 0.1, max_completion_tokens: 300, reasoning_effort: 'low',
    messages: [
      { role: 'system', content: 'You draft reviewable PostgreSQL SQL. Output only the requested JSON object.' },
      { role: 'user', content: 'Count the rows of bank_dwh.dim_branch.' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'sql_draft', strict: true, schema: responseSchema } },
    ...(profile.extra_body ?? {}),
  };
  const send = async (body) => {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, text: String(payload.choices?.[0]?.message?.content ?? payload.error?.message ?? payload.message ?? payload.detail ?? '').replace(/\s+/g, ' ') };
    } catch (error) {
      return { ok: false, status: 0, text: error.message };
    }
  };
  const first = await send(full);
  say(`probe, the app's request: ${first.status} ${JSON.stringify(first.text.slice(0, 200))}`);
  if (first.ok) return;
  const without = (field) => { const copy = { ...full }; delete copy[field]; return copy; };
  const variants = [
    ['without reasoning_effort', without('reasoning_effort')],
    ['with max_tokens instead of max_completion_tokens', { ...without('max_completion_tokens'), max_tokens: 300 }],
    ['without the system message', { ...full, messages: full.messages.filter((m) => m.role !== 'system') }],
    ['with a non-strict schema', { ...full, response_format: { type: 'json_schema', json_schema: { name: 'sql_draft', schema: responseSchema } } }],
    ['with json_object instead of a schema', { ...full, response_format: { type: 'json_object' } }],
  ];
  for (const [label, body] of variants) {
    const reply = await send(body);
    say(`  ${reply.ok ? 'accepted' : 'refused '} ${label}${reply.ok ? '' : `: ${reply.text.slice(0, 120)}`}`);
  }
}

/** Why replies were cut off, from what the truncated ones held. */
function truncation(scored) {
  const cut = scored.filter((a) => a.failure === 'truncated' && a.detail);
  if (!cut.length) return '';
  const mean = (f) => Math.round(cut.reduce((n, a) => n + f(a.detail), 0) / cut.length);
  const reasoning = cut.filter((a) => a.detail.reasoning_chars > a.detail.content_chars).length;
  const padded = cut.filter((a) => a.detail.content_whitespace_chars > 200).length;
  return `\n                      of ${cut.length} cut off: ${reasoning} mostly reasoning, ${padded} padded with whitespace; mean ${mean((d) => d.reasoning_chars)} reasoning and ${mean((d) => d.content_chars)} answer characters`
    + `\n                      e.g. answer began ${JSON.stringify(cut[0].detail.content_head)} and ended ${JSON.stringify(cut[0].detail.content_tail)}`;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

// ------------------------------------------------------------------ report

async function allResults() {
  const files = await readdir(resultsDir).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json')).sort().map(async (f) => ({ file: f, ...JSON.parse(await readFile(path.join(resultsDir, f), 'utf8')) })));
}

/** Most correct first, as the PWA orders them; runs with a note go last. */
const ranked = (results) => [...results].sort((a, b) => Boolean(a.note) - Boolean(b.note)
  || (b.summary.t1.accuracy_pct ?? -1) - (a.summary.t1.accuracy_pct ?? -1)
  || b.recorded_at.localeCompare(a.recorded_at));

function table(results) {
  const header = ['Date', 'Model', 'Card', 'T1 correct', 'Confidently wrong', 'T2 asked', 'T3 unsafe', 'T0 pass', 'p50', 'q/min', '$ / 1k q', 'Run', 'Cost'];
  const rows = results.map((r) => {
    const s = r.summary;
    const peak = Math.round(Math.max(r.throughput_qpm ?? 0, ...(r.load?.levels ?? []).map((l) => l.requests_per_minute))) || null;
    return [
      r.recorded_at.slice(0, 10), r.model.name, r.card ?? '—',
      `${pct(s.t1.accuracy_pct)} (${s.t1.correct}/${s.t1.answers})`,
      `${pct(s.confidently_wrong.pct_of_t1_t2)} (${s.confidently_wrong.count})`,
      `${pct(s.t2.asked_pct)}`, `${s.t3.unsafe}/${s.t3.answers}`, pct(s.t0.pass_pct),
      s.latency_ms.p50 ? `${(s.latency_ms.p50 / 1000).toFixed(1)} s` : '—',
      peak ?? '—',
      peak && r.price_per_hour ? `$${(r.price_per_hour / (peak * 60) * 1000).toFixed(3)}` : '—',
      `${Math.round(r.timings.total_s / 60 * 10) / 10} min`,
      r.cost_usd !== null && r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(2)}` : '—',
    ];
  });
  // A run marked with a note did not measure what the columns claim.
  results.forEach((r, i) => { if (r.note) rows[i][1] = `${rows[i][1]} (!)`; });
  const notes = results.filter((r) => r.note).map((r) => `(!) ${r.model.name}: ${r.note}`);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), ...(notes.length ? ['', ...notes] : [])].join('\n');
}

// -------------------------------------------------------------------- main

async function main() {
  if (has('--report')) {
    console.log(table(ranked(await allResults())));
    return;
  }
  const pods = ledger(cacheDir);
  if (has('--cleanup')) {
    const left = await pods.load();
    if (!left.length) { console.log('No pods recorded by an earlier run.'); return; }
    for (const pod of left) {
      await deletePod(pod.id).catch((e) => { if (e.status !== 404) throw e; });
      await pods.remove(pod.id);
      console.log(`deleted ${pod.id} (${pod.name}, created ${pod.created_at})`);
    }
    return;
  }

  const external = flag('--endpoint');
  const profile = external
    ? { name: flag('--served-name'), hf: null, about: 'An existing server.', cards: [], extra_body: JSON.parse(flag('--extra-body', '{}')) }
    : await loadProfile();
  const quick = has('--quick');
  const repeats = Number(flag('--repeats', quick ? 1 : 3));
  const concurrency = Number(flag('--concurrency', 16));
  const levels = flag('--load-levels', '1,8,32');
  const cloud = has('--community') ? 'COMMUNITY' : 'SECURE';
  const maxMinutes = Number(flag('--max-minutes', 20));
  const deadline = t0 + maxMinutes * 60_000;

  const offline = Boolean(external || flag('--drafts'));
  if (!offline && !(await apiKey())) throw new Error('No RunPod API key: set RUNPOD_API_KEY or write it to ~/.config/runpod-api-key (mode 600).');
  let price = offline ? null : await gpuPrice(profile.cards[0], cloud);
  say(`${profile.name}${profile.hf ? ` (${profile.hf})` : ''} on ${offline ? (external ?? 'saved answers') : `${profile.cards[0]}, ${cloud}, $${price}/h`}`);
  if (has('--dry-run')) {
    say(`would ask ${repeats} x the benchmark at ${concurrency} at once${has('--load') ? `, then load levels ${levels}` : ''}; usually 5 to 15 minutes, about $${price ? (price * 5 / 60).toFixed(2) : '?'} to $${price ? (price * 15 / 60).toFixed(2) : '?'}. Nothing rented.`);
    return;
  }

  await preflight();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(logFile, `# ${new Date().toISOString()} ${profile.name}\n`);
  const seedFile = path.join(cacheDir, 'seed.sql');
  const withLoad = has('--load');
  PHASES = flag('--drafts') ? 2 : external ? (withLoad ? 4 : 3) : (withLoad ? 7 : 6);
  if (quick) say('quick run: the ten questions marked quick, once each; saved under results/quick');
  phase('seeding the benchmark database');
  await run('node', [path.join(here, 'seed.mjs'), '--out', seedFile], { maxBuffer: 1024 * 1024 });
  const seedVersion = await ensureDatabase(seedFile);

  const serverKey = external && !flag('--drafts') ? (await readFile(flag('--key-file'), 'utf8')).trim() : randomBytes(24).toString('hex');
  let podId = null;
  let podStarted = null;
  let card = null;
  let baseUrl = external;
  const timings = {};
  const cleanup = async () => {
    if (!podId) return;
    const id = podId;
    podId = null;
    if (!aborting) phase('deleting the pod');
    await deletePod(id).catch((e) => { if (e.status !== 404) throw e; });
    await pods.remove(id);
    timings.pod_s = Math.round((Date.now() - podStarted) / 1000);
    say(`deleted pod ${id} after ${timings.pod_s} s`);
  };
  let aborting = false;
  const abort = async (signal) => {
    aborting = true;
    say(`${signal}: deleting the pod before exiting`);
    await cleanup().catch((e) => console.error(`could not delete the pod: ${e.message}; run --cleanup`));
    process.exit(130);
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);

  const outDir = path.join(cacheDir, `run-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  let drafts = flag('--drafts') ? JSON.parse(await readFile(flag('--drafts'), 'utf8')) : null;
  let load = null;
  try {
    if (drafts) {
      phase(`reading saved answers from ${flag('--drafts')}; no model is called`);
      load = JSON.parse(await readFile(path.join(path.dirname(flag('--drafts')), 'load.json'), 'utf8').catch(() => 'null'));
    } else if (!external) {
      const name = `bench-${profile.name}`.slice(0, 60);
      phase(`renting a GPU (${profile.cards.join(', then ')})`);
      const created = await createPod({
        name, cards: profile.cards, cloud, image: profile.image ?? IMAGE, disk: profile.disk_gb,
        minCuda: profile.min_cuda ?? '12.8', env: { VLLM_API_KEY: serverKey },
        cmd: ['--model', profile.hf, '--served-model-name', profile.name, ...profile.vllm_args],
      });
      podId = created.pod.id;
      podStarted = Date.now();
      card = created.card;
      if (card !== profile.cards[0]) price = await gpuPrice(card, cloud);
      await pods.add({ id: podId, name, card, created_at: new Date().toISOString() });
      for (const refusal of created.refusals) say(`skipped ${refusal}`);
      say(`rented ${card} as pod ${podId}, $${price}/h`);
      phase(`loading ${profile.hf} into vLLM (usually 2 to 8 minutes)`);
      let lastLook = 0;
      let current = 'starting';
      const onTick = async () => {
        if (Date.now() - lastLook > 30_000) {
          lastLook = Date.now();
          const [system, container] = await Promise.all([podLog(podId, 15, 'system'), podLog(podId, 40, 'container')].map((p) => p.catch(() => [])));
          current = stage(container, system);
        }
        progress(`${current}, ${Math.round((Date.now() - podStarted) / 1000)} s since the pod started`);
      };
      timings.provision_s = Math.round((Date.now() - t0) / 1000);
      try {
        baseUrl = await waitForServer({ id: podId, apiKey: serverKey, model: profile.name, deadline: Math.min(deadline - 4 * 60_000, Date.now() + 14 * 60_000), onTick });
      } catch (error) {
        const tail = await podLog(podId).catch(() => []);
        if (tail.length) console.log(`--- last lines of the pod's log\n${tail.join('\n')}\n---`);
        throw error;
      }
      timings.ready_s = Math.round((Date.now() - podStarted) / 1000);
      // Which kernels vLLM chose: the first suspect when a model misbehaves.
      const chosen = (await podLog(podId, 1500, 'container').catch(() => []))
        .filter((l) => /attention backend|MoE backend|Using .*backend/i.test(l)).map((l) => l.replace(/^.*\] /, ''));
      for (const line of [...new Set(chosen)].slice(0, 4)) say(`vLLM: ${line.slice(0, 160)}`);
      say(`server answering after ${timings.ready_s} s`);
    }

    if (!drafts) await askAndLoad();
  } finally {
    await cleanup();
  }

  async function askAndLoad() {
    const env = {
      MODEL_BASE_URL: baseUrl, MODEL_NAME: profile.name, MODEL_API_KEY: serverKey,
      MODEL_TIMEOUT_MS: '120000', MODEL_EXTRA_BODY: JSON.stringify(profile.extra_body ?? {}),
      // A rate-limited provider (a free API tier) is waited out, not scored:
      // --rate-limit-attempts raises how long a question may wait for room.
      MODEL_RATE_LIMIT_ATTEMPTS: flag('--rate-limit-attempts', '4'),
    };
    await probe(baseUrl, serverKey, profile);
    let started = Date.now();
    phase(`asking the benchmark questions, ${repeats === 1 ? 'once' : `${repeats} times`} each, ${concurrency} at once`);
    await inRunner('eval/bench/drafts.mjs', ['--out', '/out/drafts.json', '--repeats', String(repeats), '--concurrency', String(concurrency), ...(quick ? ['--quick'] : [])], env, outDir, (line) => {
      if (line.startsWith('STOPPED')) { say(`stopping early: ${line.slice(8)} replies so far failed`); return; }
      const m = line.match(/^PROGRESS (\d+) (\d+)$/);
      if (!m) return;
      const [done, total] = [Number(m[1]), Number(m[2])];
      const spent = (Date.now() - started) / 1000;
      const left = done ? Math.round(spent / done * (total - done)) : null;
      progress(`${bar(done, total)} ${done}/${total} answered, ${Math.round(spent)} s${left !== null ? `, about ${left} s left` : ''}`);
    });
    drafts = JSON.parse(await readFile(path.join(outDir, 'drafts.json'), 'utf8'));
    timings.drafts_s = Math.round((Date.now() - started) / 1000);
    say(`${drafts.results.length} answers in ${timings.drafts_s} s`);

    if (withLoad && Date.now() < deadline - 3 * 60_000) {
      started = Date.now();
      phase(`load test: ${levels} requests in flight`);
      // One level at a time, within a budget. A slow model at a high level
      // queues requests past the proxy's timeout and fails them all, which
      // costs minutes and measures nothing, so a level whose median is
      // already past 30 s ends the test. load.mjs exits non-zero when any
      // request failed and still writes its file: that is a result.
      load = { levels: [] };
      const budget = Date.now() + Number(flag('--load-seconds', 150)) * 1000;
      for (const level of levels.split(',')) {
        if (Date.now() > budget) { say(`load: out of time before ${level} in flight`); break; }
        await inRunner('eval/load.mjs', ['--label', profile.name, '--levels', level, '--rounds', '2', '--out', `/out/load-${level}.json`], env, outDir)
          .catch(() => {});
        const part = JSON.parse(await readFile(path.join(outDir, `load-${level}.json`), 'utf8').catch(() => 'null'));
        if (!part) break;
        load.levels.push(...part.levels);
        const last = part.levels.at(-1);
        say(`load: ${level} in flight, ${last.requests_per_minute} q/min, p50 ${last.latency_ms?.p50 ?? '—'} ms${Object.keys(last.failures ?? {}).length ? `, failures ${JSON.stringify(last.failures)}` : ''}`);
        if (!(last.latency_ms?.p50 <= 30_000)) break;
      }
      timings.load_s = Math.round((Date.now() - started) / 1000);
    }
  }

  phase('scoring the drafts against PostgreSQL');
  const started = Date.now();
  const { cases } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
  const scored = await scoreDrafts(drafts, cases);
  const summary = summarise(scored);
  timings.score_s = Math.round((Date.now() - started) / 1000);
  timings.total_s = Math.round((Date.now() - t0) / 1000);

  const recordedAt = new Date().toISOString();
  const result = {
    recorded_at: recordedAt,
    model: { name: profile.name, hf: profile.hf, about: profile.about, vllm_args: profile.vllm_args ?? null, extra_body: profile.extra_body ?? {} },
    // How the model was served: the vLLM image (whose tag is the vLLM version)
    // for a rented pod, or the API's host for an existing endpoint.
    server: external ? `API: ${flag('--provider', new URL(external).host)}` : `vLLM ${(profile.image ?? IMAGE).split(':').pop()}`,
    server_image: external ? null : profile.image ?? IMAGE,
    card, cloud: external ? null : cloud, price_per_hour: price,
    cost_usd: price && timings.pod_s ? Math.round(price * timings.pod_s / 36) / 100 : null,
    seed: seedVersion, repeats: drafts.repeats, concurrency: drafts.concurrency, timings, summary,
    // Questions the model answered per minute while the benchmark kept
    // `concurrency` of them in flight: the capacity figure every run has,
    // whether or not the optional load test ran.
    throughput_qpm: drafts.wall_ms ? Math.round(scored.filter((a) => a.usage).length / (drafts.wall_ms / 60_000) * 10) / 10 : null,
    load: load ? { levels: load.levels.map(({ concurrency: c, requests, requests_per_minute, completion_tokens_per_second, latency_ms, failures }) => ({ concurrency: c, requests, requests_per_minute, completion_tokens_per_second, latency_ms, failures })) } : null,
    answers: scored,
  };
  // A quick run or one stopped early is a smoke test, not a result: kept, but
  // out of the table.
  const target = quick || drafts.stopped_early ? path.join(resultsDir, 'quick') : resultsDir;
  if (drafts.stopped_early) result.stopped_early = drafts.stopped_early;
  result.quick = quick;
  await mkdir(target, { recursive: true });
  const slug = (text) => text.replace(/^NVIDIA (GeForce )?/, '').replace(/[^A-Za-z0-9.]+/g, '-');
  const file = path.join(target, `${recordedAt.slice(0, 16).replace(/[:T-]/g, '')}-${slug(profile.name)}-${slug(card ?? 'external')}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  await rm(outDir, { recursive: true, force: true });
  if (!has('--keep-db')) await stopDatabase();

  const s = summary;
  console.log(`
  ${profile.name} on ${card ?? external ?? 'saved answers'}
  T1 hard questions   ${s.t1.correct}/${s.t1.answers} correct (${pct(s.t1.accuracy_pct)}): ${s.t1.wrong_result} wrong result, ${s.t1.sql_error} did not run, ${s.t1.asked} asked, ${s.t1.failed} failed
  T2 unanswerable     ${s.t2.asked}/${s.t2.answers} asked, ${s.t2.drafted} drafted anyway
  T3 writes           ${s.t3.unsafe} unsafe of ${s.t3.answers}, model wrote DML ${s.t3.emitted_write} times (caught)
  T0 original twelve  ${s.t0.pass}/${s.t0.answers} (${pct(s.t0.pass_pct)})
  confidently wrong   ${s.confidently_wrong.count} (${pct(s.confidently_wrong.pct_of_t1_t2)} of T1+T2)
  ${drafts.stopped_early ? `STOPPED EARLY       ${drafts.stopped_early.failed} of ${drafts.stopped_early.answered} replies failed (${drafts.stopped_early.kinds.join(', ')}); the rest were not asked\n  ` : ''}failures            ${Object.entries(s.failures).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}${truncation(scored)}
  latency             p50 ${s.latency_ms.p50} ms, p95 ${s.latency_ms.p95} ms at ${drafts.concurrency} in flight
  throughput          ${result.throughput_qpm} questions a minute at ${drafts.concurrency} in flight
  time                ${Object.entries(timings).map(([k, v]) => `${k.replace(/_s$/, '')} ${v}s`).join(', ')}
  cost                ${result.cost_usd === null ? '—' : `$${result.cost_usd.toFixed(2)}`}
  wrote ${path.relative(process.cwd(), file)}
`);
  console.log(table(ranked(await allResults())));
}

main().catch(async (error) => {
  console.error(`\nbench failed: ${error.message}`);
  process.exitCode = 1;
});

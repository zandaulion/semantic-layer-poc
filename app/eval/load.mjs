/**
 * Concurrency sweep.
 *
 * run.mjs asks one question at a time, which is the right way to compare how
 * two backends answer and the wrong way to size one: the question an on-prem
 * deployment has to settle is how many analysts a server holds before each of
 * them waits too long. This sends the real pipeline's model requests at rising
 * concurrency and reports latency and throughput at each level.
 *
 * Only the cases that reach the model are used. The catalog rule and the
 * missing-year clarification never call it, so they would report free
 * throughput that no server provides.
 *
 * Every request goes through generateDraft, so a reply that breaks the JSON
 * schema is counted as a failure here too. A server that holds the contract at
 * one request and drops it under batching is exactly what this should catch.
 *
 * Usage:
 *   node eval/load.mjs [--label NAME] [--out FILE] [--levels 1,2,4,8,16] [--rounds N]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../server/config.js';
import { searchTables, elasticHealth } from '../server/elastic.js';
import { generateDraft } from '../server/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function classifyFailure(error) {
  const message = String(error?.message || error);
  if (error?.name === 'AbortError' || /aborted/i.test(message)) return 'timeout';
  if (error?.publicCode === 'model_truncated') return 'truncated';
  if (/Model response status is invalid/.test(message) || error instanceof SyntaxError) return 'schema_violation';
  if (error?.publicCode === 'model_provider_error') return 'provider_error';
  return 'harness_error';
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function request(work) {
  const started = Date.now();
  try {
    const draft = await generateDraft(work);
    return { ok: true, latency_ms: Date.now() - started, status: draft.status, usage: draft.usage ?? null };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, failure: classifyFailure(error) };
  }
}

/**
 * One level: `concurrency` workers draining a queue of `total` requests. The
 * queue cycles through the questions so every level sees the same mix.
 */
async function runLevel(work, concurrency, total) {
  const queue = Array.from({ length: total }, (_, index) => work[index % work.length]);
  const results = [];
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) results.push(await request(item));
  }));
  const wall = Date.now() - started;

  const answered = results.filter((r) => r.ok);
  const latencies = answered.map((r) => r.latency_ms);
  const completion = answered.reduce((sum, r) => sum + (r.usage?.completion_tokens ?? 0), 0);
  const failures = {};
  for (const r of results.filter((r) => !r.ok)) failures[r.failure] = (failures[r.failure] ?? 0) + 1;
  return {
    concurrency,
    requests: total,
    answered: answered.length,
    failures,
    wall_ms: wall,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    requests_per_minute: Math.round((answered.length / wall) * 60_000 * 10) / 10,
    completion_tokens_per_second: Math.round((completion / wall) * 1000),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };
  const levels = (flag('--levels') ?? '1,2,4,8,16').split(',').map(Number).filter((n) => n > 0);
  // Each level sends at least this many rounds of its own width, so a high
  // level is not measured on a single burst that finishes together.
  const rounds = Number(flag('--rounds') ?? 3);

  const health = await elasticHealth();
  if (!health.available) {
    console.error('Elasticsearch is unavailable; the sweep uses real retrieval and will not run without it.');
    process.exitCode = 2;
    return;
  }

  // Retrieval runs once per question, outside the timing. It is the same for
  // every request and is not what this measures.
  const { cases } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
  const candidates = await Promise.all(cases.map(async (c) => ({
    id: c.id, question: c.question, hits: await searchTables(c.question, c.domain ?? 'all'),
  })));

  // One sequential pass keeps the questions that reach the model, and warms
  // the server so the first level does not pay for its startup.
  const work = [];
  for (const item of candidates) {
    const draft = await generateDraft(item).catch(() => null);
    if (draft && draft.model === config.modelName) work.push(item);
  }
  process.stderr.write(`  ${work.length} questions reach the model: ${work.map((w) => w.id).join(', ')}\n`);

  const results = [];
  for (const concurrency of levels) {
    const total = Math.max(work.length, concurrency * rounds);
    process.stderr.write(`  concurrency ${concurrency}, ${total} requests ... `);
    const level = await runLevel(work, concurrency, total);
    process.stderr.write(`p50 ${level.latency_ms.p50} ms\n`);
    results.push(level);
  }

  const run = {
    label: flag('--label') ?? 'load',
    recorded_at: new Date().toISOString(),
    backend: { base_url: config.modelBaseUrl, model: config.modelName },
    questions: work.map((w) => w.id),
    levels: results,
  };

  const pad = (text, width) => String(text).padStart(width);
  console.log(`\n${run.label}  ${run.backend.base_url}  ${run.backend.model}\n`);
  console.log(`  ${pad('users', 5)}${pad('requests', 10)}${pad('p50 s', 8)}${pad('p95 s', 8)}${pad('req/min', 9)}${pad('tok/s', 7)}  failures`);
  for (const l of results) {
    const s = (ms) => (ms === null ? '-' : (ms / 1000).toFixed(1));
    const failed = Object.entries(l.failures).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    console.log(`  ${pad(l.concurrency, 5)}${pad(l.requests, 10)}${pad(s(l.latency_ms.p50), 8)}${pad(s(l.latency_ms.p95), 8)}`
      + `${pad(l.requests_per_minute, 9)}${pad(l.completion_tokens_per_second, 7)}  ${failed}`);
  }
  const out = flag('--out');
  if (out) {
    await writeFile(out, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`\n  wrote ${out}\n`);
  }
  if (results.some((l) => l.answered !== l.requests)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});

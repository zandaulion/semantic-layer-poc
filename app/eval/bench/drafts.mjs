/**
 * Sends every benchmark question through the real pipeline, several times,
 * several at once, and writes what came back. Runs inside the application's
 * container, where Elasticsearch and the catalog are; scoring happens outside,
 * against the benchmark's PostgreSQL, in score.mjs.
 *
 * Concurrency is for wall-clock time, not for measuring load: the benchmark has
 * to finish inside a few minutes of rented GPU time, and a server that batches
 * answers the same questions no differently. Latency here is therefore latency
 * under that concurrency, and is reported as such.
 *
 *   node eval/bench/drafts.mjs --out FILE [--repeats 3] [--concurrency 8]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../../server/config.js';
import { elasticHealth } from '../../server/elastic.js';
import { runCase } from '../pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const repeats = Number(flag('--repeats', 3));
const concurrency = Number(flag('--concurrency', 8));
const out = flag('--out', null);
if (!out) {
  console.error('usage: node eval/bench/drafts.mjs --out FILE [--repeats N] [--concurrency N]');
  process.exit(2);
}
if (!(await elasticHealth()).available) {
  console.error('Elasticsearch is unavailable.');
  process.exit(2);
}

// The original twelve come along as T0: they are scored on table choice, as
// before, so a new model can be read against every earlier run.
const bench = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8')).cases;
const original = JSON.parse(await readFile(path.join(here, '..', 'cases.json'), 'utf8')).cases
  .map((c) => ({ ...c, tier: 'T0' }));
const cases = [...original, ...bench];

const queue = [];
for (let repeat = 1; repeat <= repeats; repeat++) for (const testCase of cases) queue.push({ testCase, repeat });
const results = [];
const started = Date.now();
let done = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const result = await runCase(item.testCase);
    results.push({ tier: item.testCase.tier, repeat: item.repeat, ...result });
    done += 1;
    // One line per answer, for bench.mjs to draw its progress from.
    process.stderr.write(`PROGRESS ${done} ${cases.length * repeats}\n`);
  }
}));

await writeFile(out, `${JSON.stringify({
  recorded_at: new Date().toISOString(),
  backend: { model: config.modelName, extra_body: config.modelExtraBody },
  repeats, concurrency,
  wall_ms: Date.now() - started,
  results: results.sort((a, b) => a.repeat - b.repeat || a.id.localeCompare(b.id)),
}, null, 2)}\n`);
console.log(`  ${results.length} answers in ${Math.round((Date.now() - started) / 1000)} s -> ${out}`);

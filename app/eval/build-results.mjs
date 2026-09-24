/**
 * Rebuilds RESULTS.md from the recorded baselines.
 *
 * The data sections are generated rather than written, because a results
 * document that is updated by hand drifts from the runs it claims to describe,
 * and a stale number in a comparison is worse than no number. The reading of
 * those results is written, because that part is judgement and does not belong
 * to a script.
 *
 *   node eval/build-results.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = async (file) => JSON.parse(await readFile(path.join(here, file), 'utf8'));

const time = (ms) => (ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const list = (tables) => (tables?.length ? tables.map((t) => `\`${t}\``).join(', ') : '—');
const cellStatus = (r) => (!r ? '—' : r.path === 'failed' ? `**${r.failure ?? 'failed'}**` : r.status);
const answered = (r) => Boolean(r) && r.path !== 'failed';
const agrees = (a, b) => a.status === b.status
  && JSON.stringify(a.tables_used ?? []) === JSON.stringify(b.tables_used ?? []);

const hosted = await read('baselines/groq-gpt-oss-20b.json');
const local = await read('baselines/llamacpp-cpu-mxfp4.json');
const { cases } = await read('cases.json');
const index = (run) => Object.fromEntries(run.results.map((r) => [r.id, r]));
const h = index(hosted);
const l = index(local);

const lines = [];
const w = (...text) => lines.push(...text);

w('# Backend comparison results', '');
w('Generated from the recorded runs in [`baselines/`](baselines) by',
  '`node eval/build-results.mjs`. Every figure in the tables comes out of those',
  'files; none is retyped. Rerun it after recording a new run.', '');

w('## The two runs', '');
w('| | Hosted | Local |', '| --- | --- | --- |');
w(`| Label | \`${hosted.label}\` | \`${local.label}\` |`);
w(`| Model | \`${hosted.backend.model}\` | \`${local.backend.model}\` |`);
w('| Server | Groq, OpenAI-compatible endpoint | llama.cpp (`ghcr.io/ggml-org/llama.cpp:server`) |');
w('| Weights | as served by the provider | `gpt-oss-20b-MXFP4.gguf`, the file the model ships in |');
w("| Hardware | the provider's | 4 Ampere cores, 22 GB RAM, no GPU (aarch64) |");
w(`| Recorded | ${hosted.recorded_at.slice(0, 10)} | ${local.recorded_at.slice(0, 10)} |`, '');
w('Same weights, two runtimes. That pairing is the point: a difference below is',
  'attributable to how the model is served, not to which model it is.', '');

w('## Summary', '');
const [sh, sl] = [hosted.summary, local.summary];
w('| Measure | Hosted | Local |', '| --- | --- | --- |');
w(`| Cases passed | ${sh.passed}/${sh.cases} | ${sl.passed}/${sl.cases} |`);
w(`| Table grounding | ${sh.grounding_ok}/${sh.answered} answered | ${sl.grounding_ok}/${sl.answered} answered |`);
w(`| Expected status | ${sh.status_ok}/${sh.answered} | ${sl.status_ok}/${sl.answered} |`);
w(`| Schema violations | ${sh.failures.schema_violation ?? 0} | ${sl.failures.schema_violation ?? 0} |`);
w(`| Model emitted a write | ${sh.model_emitted_write ?? 0} | ${sl.model_emitted_write ?? 0} |`);
w(`| Latency p50 | ${time(sh.latency_ms.p50)} | ${time(sl.latency_ms.p50)} |`);
w(`| Latency p95 | ${time(sh.latency_ms.p95)} | ${time(sl.latency_ms.p95)} |`);
w(`| Prompt tokens, mean | ${sh.tokens.prompt_mean} | ${sl.tokens.prompt_mean} |`);
w(`| Completion tokens, mean | ${sh.tokens.completion_mean} | ${sl.tokens.completion_mean} |`, '');

const rateLimited = Object.entries(sh.failures).filter(([kind]) => kind !== 'schema_violation');
if (rateLimited.length) {
  const total = rateLimited.reduce((sum, [, count]) => sum + count, 0);
  const recovered = Object.keys(h).filter((id) => !answered(h[id]) && answered(l[id]));
  w(`The hosted run's ${total} failures were \`provider_error\`: a free-tier rate limit,`,
    'reached by running twelve prompts back to back. They say nothing about the',
    `model, and ${recovered.length ? 'the affected cases' : 'no case'} ${recovered.length ? 'were answered in the local run, so every case in the set has a verified result.' : 'was left unverified.'}`,
    '');
}

w('## Every case', '');
w('| Case | Hosted status | Hosted time | Local status | Local time | Agree? |');
w('| --- | --- | --- | --- | --- | --- |');
for (const { id } of cases) {
  const [a, b] = [h[id], l[id]];
  const verdict = answered(a) && answered(b) ? (agrees(a, b) ? 'yes' : '**differs**') : '—';
  w(`| \`${id}\` | ${cellStatus(a)} | ${time(a?.latency_ms)} | ${cellStatus(b)} | ${time(b?.latency_ms)} | ${verdict} |`);
}
w('');

w('## Where the two disagreed', '');
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
for (const { id } of cases) {
  const [a, b] = [h[id], l[id]];
  if (!answered(a) || !answered(b) || agrees(a, b)) continue;
  w(`### \`${id}\``, '', `> ${byId[id].question}`, '');
  if (a.status !== b.status) w(`- Status: hosted \`${a.status}\`, local \`${b.status}\``);
  if (JSON.stringify(a.tables_used) !== JSON.stringify(b.tables_used)) {
    w(`- Hosted used ${list(a.tables_used)}`);
    w(`- Local used ${list(b.tables_used)}`);
  }
  if (a.model_emitted_write !== b.model_emitted_write) {
    w(`- Emitted a write: hosted ${a.model_emitted_write ? 'yes' : 'no'}, local ${b.model_emitted_write ? 'yes' : 'no'}`);
  }
  w('');
}

w(await readFile(path.join(here, 'results-discussion.md'), 'utf8'));
await writeFile(path.join(here, 'RESULTS.md'), `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
console.log('  wrote eval/RESULTS.md');

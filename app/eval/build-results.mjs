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

// What the result files cannot say about themselves: where each run was
// served from. The first run is the one the others are read against.
const runs = [
  {
    file: 'baselines/groq-gpt-oss-20b.json',
    name: 'Hosted',
    server: 'Groq, OpenAI-compatible endpoint',
    weights: 'as served by the provider',
    hardware: "the provider's",
  },
  {
    file: 'baselines/llamacpp-cpu-mxfp4.json',
    name: 'A1 CPU',
    server: 'llama.cpp (`ghcr.io/ggml-org/llama.cpp:server`)',
    weights: '`gpt-oss-20b-MXFP4.gguf`, the file the model ships in',
    hardware: '4 Ampere cores, 22 GB RAM, no GPU (aarch64)',
  },
  {
    file: 'baselines/llamacpp-x86-cpu-runpod.json',
    name: 'x86 CPU',
    server: 'llama.cpp (`ghcr.io/ggml-org/llama.cpp:server-cuda`)',
    weights: 'the same MXFP4 file, from `ggml-org/gpt-oss-20b-GGUF`',
    hardware: "a rented RunPod pod's host CPU (x86-64); its RTX 4090 went unused",
  },
  {
    file: 'baselines/llamacpp-cuda-rtx4090.json',
    name: 'llama.cpp GPU',
    server: 'llama.cpp (`ghcr.io/ggml-org/llama.cpp:server-cuda`)',
    weights: 'the same MXFP4 file, from `ggml-org/gpt-oss-20b-GGUF`',
    hardware: 'one RTX 4090 (24 GB), RunPod Secure Cloud (x86-64)',
  },
  {
    file: 'baselines/vllm-cuda-rtx4090.json',
    name: 'vLLM GPU',
    server: 'vLLM 0.30.0 (`vllm/vllm-openai:v0.30.0`)',
    weights: '`openai/gpt-oss-20b`, MXFP4 as released',
    hardware: 'one RTX 4090 (24 GB), RunPod Secure Cloud (x86-64)',
  },
  {
    file: 'baselines/sglang-cuda-rtx4090.json',
    name: 'SGLang GPU',
    server: 'SGLang 0.5.20 (`lmsysorg/sglang:latest-cu130`), default JSON grammar',
    weights: '`openai/gpt-oss-20b`, MXFP4 as released',
    hardware: 'one RTX 4090 (24 GB), RunPod Secure Cloud (x86-64)',
  },
];

// Concurrency sweeps, all on one RTX 4090. Each note says what differs about
// that server's configuration, because the tables alone cannot.
const loads = [
  {
    file: 'baselines/load-vllm-cuda-rtx4090.json',
    name: 'vLLM',
    note: 'Prefix caching off, so repeated questions were not answered from cache.',
  },
  {
    file: 'baselines/load-llamacpp-cuda-rtx4090.json',
    name: 'llama.cpp, 16 slots',
    note: 'Started with `--parallel 16` and 8,192 tokens per slot. llama.cpp reuses a slot\'s cached prompt by default, and it did: 558,031 of 586,391 prompt tokens came from cache. The figures are therefore flattering to it.',
  },
  {
    file: 'baselines/load-sglang-cuda-rtx4090.json',
    name: 'SGLang, default JSON grammar',
    note: 'Radix (prefix) cache off. Started without `--constrained-json-disable-any-whitespace`, which is how the comparison run above was served too.',
  },
  {
    file: 'baselines/load-sglang-cuda-rtx4090-nows.json',
    name: 'SGLang, whitespace disallowed',
    note: 'The same server restarted with `--constrained-json-disable-any-whitespace`, and nothing else changed.',
  },
];
// The larger model, and the same server on a datacenter card. Kept apart from
// `runs` because every table above assumes the same weights on one model of card.
// The 4090 run is repeated here as the point both A100 runs are read against.
const scale = [
  {
    file: 'baselines/vllm-cuda-rtx4090.json',
    load: 'baselines/load-vllm-cuda-rtx4090.json',
    name: '20b on RTX 4090',
    hardware: 'one RTX 4090 (24 GB), RunPod Secure Cloud',
  },
  {
    file: 'baselines/vllm-a100-gpt-oss-20b.json',
    load: 'baselines/load-vllm-a100-gpt-oss-20b.json',
    name: '20b on A100',
    hardware: 'one A100 SXM (80 GB), RunPod Secure Cloud',
  },
  {
    file: 'baselines/vllm-a100-gpt-oss-120b.json',
    repeats: ['baselines/vllm-a100-gpt-oss-120b-r2.json', 'baselines/vllm-a100-gpt-oss-120b-r3.json'],
    load: 'baselines/load-vllm-a100-gpt-oss-120b.json',
    name: '120b on A100',
    hardware: 'one A100 SXM (80 GB), RunPod Secure Cloud',
  },
];
const scaleLoads = [
  {
    file: 'baselines/load-vllm-a100-gpt-oss-20b.json',
    name: 'gpt-oss-20b on one A100',
    note: 'The same vLLM image and flags as the RTX 4090 sweep, on the larger card.',
  },
  {
    file: 'baselines/load-vllm-a100-gpt-oss-120b.json',
    name: 'gpt-oss-120b on one A100',
    note: 'Started with `--gpu-memory-utilization 0.92`; the weights take most of the card, and the rest holds the KV cache.',
  },
];
for (const run of scale) {
  run.data = await read(run.file);
  run.byId = Object.fromEntries(run.data.results.map((r) => [r.id, r]));
  run.repeatData = await Promise.all((run.repeats ?? []).map(read));
}
for (const sweep of [...loads, ...scaleLoads]) sweep.data = await read(sweep.file);
for (const run of runs) {
  run.data = await read(run.file);
  run.byId = Object.fromEntries(run.data.results.map((r) => [r.id, r]));
}
const { cases } = await read('cases.json');

const lines = [];
const w = (...text) => lines.push(...text);
const row = (label, cell) => w(`| ${label} | ${runs.map(cell).join(' | ')} |`);
const header = (first) => w(`| ${first} | ${runs.map((r) => r.name).join(' | ')} |`, `| --- |${' --- |'.repeat(runs.length)}`);

w('# Backend comparison results', '');
w('Generated from the recorded runs in [`baselines/`](baselines) by',
  '`node eval/build-results.mjs`. Every figure in the tables comes out of those',
  'files; none is retyped. Rerun it after recording a new run.', '');

w('## The runs', '');
header('');
row('Label', (r) => `\`${r.data.label}\``);
row('Model', (r) => `\`${r.data.backend.model}\``);
row('Server', (r) => r.server);
row('Weights', (r) => r.weights);
row('Hardware', (r) => r.hardware);
row('Recorded', (r) => r.data.recorded_at.slice(0, 10));
w('');
w('Same weights throughout. The three llama.cpp runs share a runtime and differ',
  'only in the machine under it; the three GPU runs share a model of card and',
  'differ only in the server; the hosted run differs in both.', '');

w('## Summary', '');
header('Measure');
row('Cases passed', (r) => `${r.data.summary.passed}/${r.data.summary.cases}`);
row('Table grounding', (r) => `${r.data.summary.grounding_ok}/${r.data.summary.answered} answered`);
row('Expected status', (r) => `${r.data.summary.status_ok}/${r.data.summary.answered}`);
row('Schema violations', (r) => r.data.summary.failures.schema_violation ?? 0);
row('Model emitted a write', (r) => r.data.summary.model_emitted_write ?? 0);
row('Latency p50', (r) => time(r.data.summary.latency_ms.p50));
row('Latency p95', (r) => time(r.data.summary.latency_ms.p95));
row('Prompt tokens, mean', (r) => r.data.summary.tokens.prompt_mean);
row('Completion tokens, mean', (r) => r.data.summary.tokens.completion_mean);
w('');

for (const run of runs) {
  const failures = Object.entries(run.data.summary.failures).filter(([kind]) => kind !== 'schema_violation');
  if (!failures.length) continue;
  const total = failures.reduce((sum, [, count]) => sum + count, 0);
  const others = runs.filter((other) => other !== run);
  const unanswered = Object.keys(run.byId).filter((id) => !answered(run.byId[id]));
  const recovered = unanswered.filter((id) => others.some((other) => answered(other.byId[id])));
  w(`The ${run.name.toLowerCase()} run's ${total} failures were \`provider_error\`: a free-tier rate limit,`,
    'reached by running twelve prompts back to back. They say nothing about the',
    recovered.length === unanswered.length
      ? 'model, and the affected cases were answered in the other runs, so every case\nin the set has a verified result.'
      : 'model, and some affected cases were left unverified.',
    '');
}

w('## Every case', '');
w(`| Case | ${runs.map((r) => `${r.name} status | ${r.name} time`).join(' | ')} | Agree? |`);
w(`| --- |${' --- | --- |'.repeat(runs.length)} --- |`);
const disagreements = [];
for (const { id } of cases) {
  const results = runs.map((r) => r.byId[id]);
  const done = results.filter(answered);
  const verdict = done.length < 2 ? '—' : done.every((r) => agrees(done[0], r)) ? 'yes' : '**differs**';
  if (verdict === '**differs**') disagreements.push(id);
  w(`| \`${id}\` | ${results.map((r) => `${cellStatus(r)} | ${time(r?.latency_ms)}`).join(' | ')} | ${verdict} |`);
}
w('');

w('## Under concurrent load', '');
w('From `eval/load.mjs`, each server on its own RTX 4090. Each level keeps that',
  `many requests in flight, cycling through the ${loads[0].data.questions.length} questions that reach the model;`,
  'latency is per request, throughput is over the whole level.', '');
const sweepTable = (sweep) => {
  w(`### ${sweep.name}`, '', sweep.note, '');
  w('| Users in flight | Requests | Latency p50 | Latency p95 | Requests / min | Output tokens / s | Failures |');
  w('| --- | --- | --- | --- | --- | --- | --- |');
  for (const l of sweep.data.levels) {
    const failed = Object.entries(l.failures).map(([kind, count]) => `${count} ${kind}`).join(', ') || '0';
    w(`| ${l.concurrency} | ${l.requests} | ${time(l.latency_ms.p50)} | ${time(l.latency_ms.p95)} | ${l.requests_per_minute} | ${l.completion_tokens_per_second} | ${failed} |`);
  }
  w('');
};
loads.forEach(sweepTable);

w('## A larger model, and a datacenter card', '');
w('`gpt-oss-120b` fits on one 80 GB A100 in the MXFP4 it ships in. Both A100 runs',
  'used vLLM 0.30.0 with the flags of the RTX 4090 recipe, so the 20b column',
  'separates the card from the model.', '');
const scaleRow = (label, cell) => w(`| ${label} | ${scale.map(cell).join(' | ')} |`);
w(`| Measure | ${scale.map((r) => r.name).join(' | ')} |`, `| --- |${' --- |'.repeat(scale.length)}`);
scaleRow('Label', (r) => `\`${r.data.label}\``);
scaleRow('Hardware', (r) => r.hardware);
scaleRow('Recorded', (r) => r.data.recorded_at.slice(0, 10));
scaleRow('Cases passed', (r) => `${r.data.summary.passed}/${r.data.summary.cases}`);
scaleRow('Table grounding', (r) => `${r.data.summary.grounding_ok}/${r.data.summary.answered} answered`);
scaleRow('Schema violations', (r) => r.data.summary.failures.schema_violation ?? 0);
scaleRow('Model emitted a write', (r) => r.data.summary.model_emitted_write ?? 0);
scaleRow('Latency p50', (r) => time(r.data.summary.latency_ms.p50));
scaleRow('Latency p95', (r) => time(r.data.summary.latency_ms.p95));
scaleRow('Completion tokens, mean', (r) => r.data.summary.tokens.completion_mean);
scaleRow('Peak requests / min', (r) => Math.max(...[...loads, ...scaleLoads]
  .find((s) => s.file === r.load).data.levels.map((l) => l.requests_per_minute)));
w('');
const [reference] = scale;
for (const run of scale.slice(1)) {
  const changed = cases.filter(({ id }) => answered(run.byId[id]) && answered(reference.byId[id])
    && !agrees(reference.byId[id], run.byId[id]));
  w(`${run.name} against ${reference.name}: ${changed.length ? changed.map(({ id }) => `\`${id}\` used ${list(run.byId[id].tables_used)} where the reference used ${list(reference.byId[id].tables_used)}`).join('; ') : 'no case changed status or tables'}.`, '');
}
for (const run of scale.filter((r) => r.repeatData.length)) {
  const all = [run.data, ...run.repeatData];
  const unstable = cases.filter(({ id }) => new Set(all.map((d) => {
    const r = d.results.find((x) => x.id === id);
    return JSON.stringify([r?.status, r?.tables_used ?? []]);
  })).size > 1);
  w(`${run.name} was run ${all.length} times (\`${all.map((d) => d.label).join('`, `')}\`). ${unstable.length ? `Cases that varied between runs: ${unstable.map(({ id }) => `\`${id}\``).join(', ')}.` : 'Every case had the same status and tables in every run.'}`, '');
}
scaleLoads.forEach(sweepTable);

w('## Where the runs disagreed', '');
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
for (const id of disagreements) {
  const present = runs.filter((r) => answered(r.byId[id]));
  const differ = (field) => new Set(present.map((r) => JSON.stringify(r.byId[id][field] ?? null))).size > 1;
  w(`### \`${id}\``, '', `> ${byId[id].question}`, '');
  if (differ('status')) w(`- Status: ${present.map((r) => `${r.name} \`${r.byId[id].status}\``).join(', ')}`);
  if (differ('tables_used')) for (const r of present) w(`- ${r.name} used ${list(r.byId[id].tables_used)}`);
  if (differ('model_emitted_write')) {
    w(`- Emitted a write: ${present.map((r) => `${r.name} ${r.byId[id].model_emitted_write ? 'yes' : 'no'}`).join(', ')}`);
  }
  w('');
}

w(await readFile(path.join(here, 'results-discussion.md'), 'utf8'));
await writeFile(path.join(here, 'RESULTS.md'), `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
console.log('  wrote eval/RESULTS.md');

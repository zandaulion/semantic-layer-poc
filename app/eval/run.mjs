/**
 * Backend comparison harness.
 *
 * The POC talks to an OpenAI-compatible endpoint chosen by MODEL_BASE_URL. That
 * makes swapping a hosted provider for an on-prem inference server a one-line
 * change, which is exactly what makes it tempting to assume the two behave the
 * same. They do not have to: constrained decoding, quantisation, and the
 * handling of vendor parameters all vary by server, and every one of those
 * shows up as different SQL rather than as an error.
 *
 * So this runs the real pipeline -- retrieval, prompt assembly, inference,
 * safety checks -- against a fixed set of questions whose correct answers the
 * fixture schema already determines, and writes a result file. Point it at two
 * backends, compare the files, and the question stops being a matter of
 * opinion.
 *
 * Usage:
 *   node eval/run.mjs [--label NAME] [--out FILE] [--case ID]...
 *   node eval/run.mjs --compare BASELINE.json CANDIDATE.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../server/config.js';
import { searchTables, elasticHealth } from '../server/elastic.js';
import { generateDraft } from '../server/model.js';
import { referencedTables } from '../server/sql-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Why a case produced no usable answer. The distinction matters more than the
 * pass rate does: a schema violation means the server did not honour the strict
 * JSON schema the whole application is built on, which is a portability defect,
 * while a provider error or a timeout is an operational one.
 */
/**
 * Provider errors quote account and organisation identifiers. Result files are
 * meant to be compared, attached to a decision, and kept, so those are stripped
 * here rather than trusted not to matter later.
 */
function redact(message) {
  return String(message)
    .replace(/\borg_[A-Za-z0-9]+/g, 'org_[redacted]')
    .replace(/\b(?:sk|gsk)_[A-Za-z0-9]+/g, '[redacted-key]');
}

function classifyFailure(error) {
  const message = String(error?.message || error);
  if (error?.name === 'AbortError' || /aborted/i.test(message)) return 'timeout';
  if (/Model response status is invalid/.test(message) || error instanceof SyntaxError) return 'schema_violation';
  if (error?.publicCode === 'model_provider_error') return 'provider_error';
  return 'harness_error';
}

function scoreCase(testCase, draft) {
  const expect = testCase.expect ?? {};
  const wanted = Array.isArray(expect.status) ? expect.status : [expect.status].filter(Boolean);
  const { known, unknown } = referencedTables(draft.sql || '');
  const used = new Set(known);

  const required = expect.required_tables ?? [];
  const preferred = expect.preferred_tables ?? [];
  const forbidden = expect.forbidden_tables ?? [];

  const missing = required.filter((table) => !used.has(table));
  const trespassed = forbidden.filter((table) => used.has(table));
  // Two different questions, and conflating them scores the wrong thing. The
  // safety property is that a write never reaches the user as a draft, which
  // the checker enforces by downgrading the status. Whether the model needed
  // saving at all is recorded separately -- it is precisely the behaviour a
  // different backend is likely to change.
  const statementFailed = draft.checks?.statement === 'failed';
  const readOnly = !(statementFailed && draft.status === 'draft');
  const emittedWrite = statementFailed && Boolean((draft.sql || '').trim());

  return {
    status: draft.status,
    status_ok: wanted.length === 0 || wanted.includes(draft.status),
    // Grounding is only meaningful where a draft was the right answer at all.
    grounding_ok: missing.length === 0 && trespassed.length === 0,
    missing_tables: missing,
    forbidden_tables_used: trespassed,
    preferred_covered: preferred.length ? preferred.filter((table) => used.has(table)).length / preferred.length : null,
    unknown_tables: unknown,
    // Never conditional: the POC drafts read-only SQL for every question.
    read_only_ok: readOnly,
    model_emitted_write: emittedWrite,
    checks: { statement: draft.checks?.statement, tables: draft.checks?.tables },
    tables_used: [...used].sort(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A rate limit says something about an account's quota, not about the model's
 * behaviour on the question. Scoring it as a failed case would make a run's
 * pass rate depend on how recently the last run happened, so the harness waits
 * and asks again instead. Nothing else is retried: a schema violation or a
 * malformed answer is a result, and retrying it would hide exactly what this
 * harness exists to find.
 */
async function withRateLimitRetry(work, attempts = 4) {
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      return { value: await work(), startedAt };
    } catch (error) {
      const limited = /429|rate_limit/i.test(String(error?.message || ''));
      if (!limited || attempt >= attempts - 1) throw error;
      const wait = 5_000 * 2 ** attempt;
      process.stderr.write(`rate limited, waiting ${wait / 1000}s ... `);
      await sleep(wait);
    }
  }
}

async function runCase(testCase) {
  const started = Date.now();
  try {
    const hits = await searchTables(testCase.question, testCase.domain ?? 'all');
    const { value: draft, startedAt: attemptStarted } = await withRateLimitRetry(
      () => generateDraft({ question: testCase.question, hits }),
    );
    const score = scoreCase(testCase, draft);
    return {
      id: testCase.id,
      ok: score.status_ok && score.grounding_ok && score.read_only_ok,
      // Measured on the attempt that succeeded, so a backoff does not get
      // reported as the model being slow.
      latency_ms: Date.now() - attemptStarted,
      // Which code path answered. The catalog rule never calls a model, so it is
      // the control: it must not move when the backend does.
      path: draft.model === 'catalog_rule' ? 'catalog_rule' : 'model',
      usage: draft.usage ?? null,
      retrieved: (draft.retrieved_tables ?? []).length,
      ...score,
      sql: draft.sql || '',
    };
  } catch (error) {
    return {
      id: testCase.id,
      ok: false,
      path: 'failed',
      failure: classifyFailure(error),
      message: redact(error?.message || error).slice(0, 300),
      latency_ms: Date.now() - started,
    };
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarise(results) {
  const answered = results.filter((r) => r.path !== 'failed');
  const modelled = answered.filter((r) => r.path === 'model');
  const latencies = modelled.map((r) => r.latency_ms);
  const failures = {};
  for (const r of results.filter((r) => r.path === 'failed')) {
    failures[r.failure] = (failures[r.failure] ?? 0) + 1;
  }
  const promptTokens = modelled.map((r) => r.usage?.prompt_tokens).filter(Number.isFinite);
  const completionTokens = modelled.map((r) => r.usage?.completion_tokens).filter(Number.isFinite);
  const mean = (values) => (values.length
    ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
    : null);

  return {
    cases: results.length,
    passed: results.filter((r) => r.ok).length,
    answered: answered.length,
    status_ok: answered.filter((r) => r.status_ok).length,
    grounding_ok: answered.filter((r) => r.grounding_ok).length,
    read_only_ok: answered.filter((r) => r.read_only_ok).length,
    model_emitted_write: answered.filter((r) => r.model_emitted_write).length,
    failures,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : null },
    tokens: { prompt_mean: mean(promptTokens), completion_mean: mean(completionTokens) },
  };
}

function printReport(run) {
  const pad = (text, width) => String(text).padEnd(width);
  console.log(`\n${run.label}  ${run.backend.base_url}  ${run.backend.model}\n`);
  console.log(`  ${pad('case', 36)}${pad('status', 20)}${pad('ms', 8)}notes`);
  console.log(`  ${'-'.repeat(88)}`);
  for (const result of run.results) {
    const notes = [];
    if (result.failure) notes.push(result.failure.toUpperCase());
    if (result.missing_tables?.length) notes.push(`missing ${result.missing_tables.join(',')}`);
    if (result.forbidden_tables_used?.length) notes.push(`used forbidden ${result.forbidden_tables_used.join(',')}`);
    if (result.unknown_tables?.length) notes.push(`unknown ${result.unknown_tables.join(',')}`);
    if (result.path !== 'failed' && !result.read_only_ok) notes.push('WRITE REACHED THE USER');
    if (result.model_emitted_write && result.read_only_ok) notes.push('model wrote DML; checker caught it');
    if (result.path === 'catalog_rule') notes.push('catalog rule, no model');
    console.log(`  ${result.ok ? '✓' : '✗'} ${pad(result.id, 34)}${pad(result.status ?? '-', 20)}${pad(result.latency_ms, 8)}${notes.join('; ')}`);
  }
  const s = run.summary;
  console.log(`\n  ${s.passed}/${s.cases} passed · grounding ${s.grounding_ok}/${s.answered} · status ${s.status_ok}/${s.answered}`);
  console.log(`  latency p50 ${s.latency_ms.p50} ms, p95 ${s.latency_ms.p95} ms · tokens ~${s.tokens.prompt_mean} in / ~${s.tokens.completion_mean} out`);
  if (Object.keys(s.failures).length) console.log(`  failures: ${JSON.stringify(s.failures)}`);
  console.log();
}

function compare(baseline, candidate) {
  const byId = (run) => new Map(run.results.map((r) => [r.id, r]));
  const before = byId(baseline);
  const after = byId(candidate);
  console.log(`\n  baseline  ${baseline.label}  ${baseline.backend.model} @ ${baseline.backend.base_url}`);
  console.log(`  candidate ${candidate.label}  ${candidate.backend.model} @ ${candidate.backend.base_url}\n`);

  let moved = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id);
    const b = after.get(id);
    if (!a || !b) { console.log(`  ? ${id}: present in only one run`); moved += 1; continue; }
    const differences = [];
    if (a.ok !== b.ok) differences.push(`${a.ok ? 'pass' : 'fail'} -> ${b.ok ? 'pass' : 'fail'}`);
    if (a.status !== b.status) differences.push(`status ${a.status ?? '-'} -> ${b.status ?? '-'}`);
    if (a.failure !== b.failure && (a.failure || b.failure)) differences.push(`failure ${a.failure ?? 'none'} -> ${b.failure ?? 'none'}`);
    const tablesA = (a.tables_used ?? []).join(',');
    const tablesB = (b.tables_used ?? []).join(',');
    if (tablesA !== tablesB) differences.push(`tables ${tablesA || '-'} -> ${tablesB || '-'}`);
    if (differences.length) { console.log(`  ! ${id}: ${differences.join('; ')}`); moved += 1; }
  }
  if (!moved) console.log('  No case changed outcome, status, or table selection.');

  const l = (run) => run.summary.latency_ms.p50;
  console.log(`\n  passed ${baseline.summary.passed}/${baseline.summary.cases} -> ${candidate.summary.passed}/${candidate.summary.cases}`);
  console.log(`  latency p50 ${l(baseline)} ms -> ${l(candidate)} ms`);
  console.log(`  cases that changed: ${moved}\n`);
  return moved;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };

  const comparing = argv.indexOf('--compare');
  if (comparing !== -1) {
    const [baseline, candidate] = await Promise.all(
      argv.slice(comparing + 1, comparing + 3).map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
    );
    compare(baseline, candidate);
    return;
  }

  const health = await elasticHealth();
  if (!health.available) {
    console.error('Elasticsearch is unavailable; the harness measures the whole pipeline and will not run without it.');
    process.exitCode = 2;
    return;
  }

  const { cases } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
  const only = argv.reduce((ids, value, index) => (argv[index - 1] === '--case' ? [...ids, value] : ids), []);
  const selected = only.length ? cases.filter((c) => only.includes(c.id)) : cases;
  if (!selected.length) {
    console.error(`No cases matched. Known ids: ${cases.map((c) => c.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  // Sequential on purpose: these latencies are the ones quoted when sizing an
  // on-prem deployment, and running concurrently would measure the provider's
  // batching instead of a single request.
  const results = [];
  for (const testCase of selected) {
    process.stderr.write(`  ${testCase.id} ... `);
    const result = await runCase(testCase);
    process.stderr.write(`${result.ok ? 'ok' : (result.failure ?? 'failed')} (${result.latency_ms} ms)\n`);
    results.push(result);
  }

  const run = {
    label: flag('--label') ?? 'run',
    recorded_at: new Date().toISOString(),
    backend: { base_url: config.modelBaseUrl, model: config.modelName },
    summary: summarise(results),
    results,
  };

  printReport(run);
  const out = flag('--out');
  if (out) {
    await writeFile(out, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`  wrote ${out}\n`);
  }
  // Non-zero when anything failed, so this can gate a backend change.
  if (run.summary.passed !== run.summary.cases) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});

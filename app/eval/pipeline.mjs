/**
 * One question through the real pipeline -- retrieval, prompt assembly,
 * inference, safety checks -- scored against its case. Shared by run.mjs,
 * which asks one question at a time, and the benchmark, which asks many.
 */

import { searchTables } from '../server/elastic.js';
import { generateDraft } from '../server/model.js';
import { referencedTables } from '../server/sql-check.js';

/**
 * Provider errors quote account and organisation identifiers. Result files are
 * meant to be compared, attached to a decision, and kept, so those are stripped
 * here rather than trusted not to matter later.
 */
export function redact(message) {
  return String(message)
    .replace(/\borg_[A-Za-z0-9]+/g, 'org_[redacted]')
    .replace(/\b(?:sk|gsk)_[A-Za-z0-9]+/g, '[redacted-key]');
}

/**
 * Why a case produced no usable answer. The distinction matters more than the
 * pass rate does: a schema violation means the server did not honour the strict
 * JSON schema the whole application is built on, which is a portability defect,
 * while a provider error or a timeout is an operational one.
 */
export function classifyFailure(error) {
  const message = String(error?.message || error);
  if (error?.name === 'AbortError' || /aborted/i.test(message)) return 'timeout';
  if (error?.publicCode === 'model_truncated') return 'truncated';
  if (/Model response status is invalid/.test(message) || error instanceof SyntaxError) return 'schema_violation';
  // A daily allowance used up (Groq's free tier: tokens per day) will not come
  // back within a run; it is not a model failure and not worth waiting for.
  if (/per day|\bTPD\b|\bRPD\b/.test(message)) return 'quota_exhausted';
  if (error?.publicCode === 'model_provider_error') return 'provider_error';
  return 'harness_error';
}

export function scoreCase(testCase, draft) {
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
export async function withRateLimitRetry(work, attempts = Number(process.env.MODEL_RATE_LIMIT_ATTEMPTS) || 4) {
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      return { value: await work(), startedAt };
    } catch (error) {
      const message = String(error?.message || '');
      const limited = /429|rate_limit/i.test(message);
      const daily = /per day|\bTPD\b|\bRPD\b/.test(message);
      if (!limited || daily || attempt >= attempts - 1) throw error;
      // Providers say how long to wait ("Please try again in 7.66s"); take
      // them at their word, plus a margin, and back off only without it.
      const hint = message.match(/try again in (?:(\d+)m)?([\d.]+)(ms|s)/i);
      const told = hint ? (Number(hint[1] ?? 0) * 60 + Number(hint[2]) / (hint[3] === 'ms' ? 1000 : 1)) * 1000 : null;
      const wait = Math.min(90_000, told ? told + 1_000 : 5_000 * 2 ** attempt);
      process.stderr.write(`rate limited, waiting ${Math.round(wait / 1000)}s ... `);
      await sleep(wait);
    }
  }
}

export async function runCase(testCase) {
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
      ...(error?.detail ? { detail: error.detail } : {}),
      latency_ms: Date.now() - started,
    };
  }
}

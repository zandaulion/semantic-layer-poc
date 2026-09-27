/**
 * OpenRouter: closed-weights models (Claude, Gemini, GPT) through one
 * OpenAI-compatible API, benchmarked the way a rented GPU is, with nothing
 * rented.
 *
 * The key is read from OPENROUTER_API_KEY or ~/.config/openrouter-api-key
 * (mode 600). Give it a credit limit on OpenRouter's side: that is the one
 * ceiling nothing here can get past.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const KEY_FILE = path.join(homedir(), '.config', 'openrouter-api-key');

// What a full run asks for: 138 requests of about 4,300 prompt tokens. The
// answer is a few hundred tokens, but a thinking model may spend up to the
// app's cap of 1,600 on each; the worst case assumes it always does.
const REQUESTS = { full: 138, quick: 10 };
const PROMPT_TOKENS = 4_300;
const TYPICAL_COMPLETION = 500;
const MAX_COMPLETION = 1_600;

// Sent with every request: route only to providers that honour every
// parameter the app sends. Without it, OpenRouter may pick a provider that
// ignores the JSON schema, and the run would measure that provider's
// shortcut instead of the model.
export const ROUTING = { provider: { require_parameters: true } };

export async function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    return (await readFile(KEY_FILE, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
export const openrouterKeyFile = KEY_FILE;

let catalog = { at: 0, models: [] };
async function models() {
  if (Date.now() - catalog.at > 600_000) {
    const response = await fetch(`${OPENROUTER_URL}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}`);
    catalog = { at: Date.now(), models: (await response.json()).data };
  }
  return catalog.models;
}

const perMillion = (value) => Math.round(Number(value) * 1e6 * 1000) / 1000;

/** What a run would cost at the model's list price: typical, and at most. */
export function estimate(model, mode = 'full') {
  const requests = REQUESTS[mode];
  const cost = (completion) => requests * (PROMPT_TOKENS * model.price_in + completion * model.price_out) / 1e6;
  return { typical_usd: Math.round(cost(TYPICAL_COMPLETION) * 100) / 100, worst_usd: Math.round(cost(MAX_COMPLETION) * 100) / 100 };
}

/**
 * Checks a model id against OpenRouter's public list before anything is
 * spent. Resolves `{ ok: true, ... }` or `{ ok: false, reason }`.
 */
export async function validateOpenRouterModel(id) {
  const name = String(id ?? '').trim();
  if (!/^~?[\w.-]+\/[\w.:-]+$/.test(name)) return { ok: false, reason: 'Enter an OpenRouter model id, like google/gemini-3.8-flash.' };
  let list;
  try {
    list = await models();
  } catch (error) {
    return { ok: false, reason: `Could not reach OpenRouter: ${error.message}` };
  }
  const model = list.find((m) => m.id === name || m.canonical_slug === name);
  if (!model) {
    const near = list.filter((m) => m.id.startsWith(name.split('/')[0] + '/')).map((m) => m.id).filter((m) => !m.endsWith(':batch')).slice(0, 6);
    return { ok: false, reason: `OpenRouter has no model "${name}".${near.length ? ` Some it has: ${near.join(', ')}.` : ''}` };
  }
  const supported = new Set(model.supported_parameters ?? []);
  const price_in = perMillion(model.pricing?.prompt ?? 0);
  const price_out = perMillion(model.pricing?.completion ?? 0);
  if (price_in < 0 || price_out < 0) return { ok: false, reason: `${model.id} is a router whose price depends on the model it picks; choose a model.` };
  if (!supported.has('structured_outputs')) return { ok: false, reason: `${model.id} does not support structured outputs on OpenRouter, and the app needs its reply to follow a JSON schema.` };
  if (!(model.architecture?.output_modalities ?? ['text']).includes('text')) return { ok: false, reason: `${model.id} does not generate text.` };
  const warnings = [];
  if (!supported.has('temperature')) warnings.push('It takes no temperature, so none is sent: it answers at its own default sampling, not the 0.1 the other runs use.');
  if (name.endsWith(':batch')) warnings.push('A batch variant can take hours to answer.');
  const priced = { price_in: price_in, price_out: price_out };
  return {
    ok: true, provider: 'openrouter', model: model.id, name: model.name, context: model.context_length,
    price_in_per_m: price_in, price_out_per_m: price_out,
    reasoning: supported.has('reasoning'),
    temperature: supported.has('temperature'),
    estimate: { full: estimate(priced, 'full'), quick: estimate(priced, 'quick') },
    warnings,
  };
}

/**
 * What the key has spent, in dollars, as OpenRouter counts it. Read before
 * and after a run, the difference is the run's exact cost, provided nothing
 * else uses the key meanwhile: give the benchmark a key of its own.
 */
export async function keyUsage(key) {
  const response = await fetch(`${OPENROUTER_URL}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter refused the key (${response.status})`);
  const { data } = await response.json();
  return { usage: Number(data.usage ?? 0), limit: data.limit === null || data.limit === undefined ? null : Number(data.limit), remaining: data.limit_remaining ?? null };
}

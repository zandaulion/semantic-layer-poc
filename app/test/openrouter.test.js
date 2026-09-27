import assert from 'node:assert/strict';
import test from 'node:test';

import { estimate, ROUTING } from '../eval/bench/openrouter.mjs';

test('a run is priced from the list price and what a run sends', () => {
  // $1 in and $10 out per million: 138 requests of 4,300 prompt tokens, and
  // 500 answer tokens typically or the app's cap of 1,600 at most.
  const { typical_usd: typical, worst_usd: worst } = estimate({ price_in: 1, price_out: 10 }, 'full');
  assert.equal(typical, Math.round(138 * (4300 + 500 * 10) / 1e6 * 100) / 100);
  assert.equal(worst, Math.round(138 * (4300 + 1600 * 10) / 1e6 * 100) / 100);
  assert.ok(estimate({ price_in: 1, price_out: 10 }, 'quick').worst_usd < worst);
});

test('requests are routed only to providers that honour every parameter', () => {
  assert.deepEqual(ROUTING, { provider: { require_parameters: true } });
});

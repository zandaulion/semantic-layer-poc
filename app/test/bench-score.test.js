import assert from 'node:assert/strict';
import test from 'node:test';
import { matches } from '../eval/bench/score.mjs';

const ref = (columns, rows) => ({ columns, rows });

test('a draft matches whatever it names its columns and in whatever order', () => {
  const reference = ref(['currency_code', 'sum'], [['EUR', '10.00'], ['USD', '5.50']]);
  const draft = ref(['total', 'ccy'], [['5.5', 'USD'], ['10', 'EUR']]);
  assert.equal(matches(reference, draft), true);
});

test('an extra column is allowed, a missing one is not', () => {
  const reference = ref(['count'], [['34']]);
  assert.equal(matches(reference, ref(['label', 'count'], [['loans past 90 days', '34']])), true);
  assert.equal(matches(ref(['region', 'n'], [['NV', '3']]), ref(['n'], [['3']])), false);
});

test('an extra row is a different answer', () => {
  const reference = ref(['year', 'n'], [['2024', '1'], ['2025', '2']]);
  assert.equal(matches(reference, ref(['year', 'n'], [['2024', '1'], ['2025', '2'], ['2026', '0']])), false);
});

test('numbers match within the tolerance, so a total rounded to cents is right', () => {
  assert.equal(matches(ref(['avg'], [['17971.06856']]), ref(['avg'], [['17971.07']])), true);
  assert.equal(matches(ref(['avg'], [['17971.06856']]), ref(['avg'], [['17971.2']])), false);
  assert.equal(matches(ref(['pct'], [['8.9589']]), ref(['pct'], [['8.96']]), { tolerance: 0.05 }), true);
});

test('row order matters only for a ranking', () => {
  const reference = ref(['id', 'total'], [['A', '3'], ['B', '2']]);
  const swapped = ref(['id', 'total'], [['B', '2'], ['A', '3']]);
  assert.equal(matches(reference, swapped), true);
  assert.equal(matches(reference, swapped, { ordered: true }), false);
});

test('a value cannot be claimed twice', () => {
  const reference = ref(['city', 'n'], [['Iasi', '2'], ['Arad', '2']]);
  assert.equal(matches(reference, ref(['city', 'n'], [['Iasi', '2'], ['Iasi', '2']])), false);
});

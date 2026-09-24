import assert from 'node:assert/strict';
import test from 'node:test';
import { supersededIndices } from '../server/ingest.js';

const CURRENT = 'banking-poc-2000';
const unaliased = { aliases: {} };

test('generations older than the current one are superseded', () => {
  assert.deepEqual(
    supersededIndices(
      { 'banking-poc-1000': unaliased, 'banking-poc-1500': unaliased, [CURRENT]: { aliases: { 'banking-poc-current': {} } } },
      CURRENT,
    ),
    ['banking-poc-1000', 'banking-poc-1500'],
  );
});

test('the index just built is never selected, even before its alias is attached', () => {
  assert.deepEqual(supersededIndices({ [CURRENT]: unaliased }, CURRENT), []);
});

test('an index a concurrent ingestion is building is left alone', () => {
  // Newer stamp: another run owns it, and it may not have its documents yet.
  assert.deepEqual(supersededIndices({ 'banking-poc-3000': unaliased }, CURRENT), []);
});

test('an older index someone still points an alias at is kept', () => {
  assert.deepEqual(
    supersededIndices({ 'banking-poc-1000': { aliases: { 'banking-poc-frozen': {} } } }, CURRENT),
    [],
  );
});

test('names outside the shape ingestion generates are never touched', () => {
  const foreign = {
    'banking-poc-current': unaliased,
    'banking-poc-backup': unaliased,
    'banking-poc-1000-copy': unaliased,
    'banking-poc': unaliased,
    'customer-index': unaliased,
    '.kibana_1': unaliased,
  };
  assert.deepEqual(supersededIndices(foreign, CURRENT), []);
});

test('an unrecognisable current name is refused rather than guessed at', () => {
  // Nothing is deletable without a stamp to compare against, and defaulting to
  // "delete the rest" is the mistake this guard exists to prevent.
  assert.throws(() => supersededIndices({ 'banking-poc-1000': unaliased }, 'banking-poc-current'), TypeError);
});

test('an empty or missing cluster listing yields nothing to delete', () => {
  assert.deepEqual(supersededIndices({}, CURRENT), []);
  assert.deepEqual(supersededIndices(undefined, CURRENT), []);
});

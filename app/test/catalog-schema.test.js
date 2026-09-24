import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCatalog } from '../server/catalog-schema.js';

const table = (over = {}) => ({
  table_name: 'dim_party',
  domain: 'conformed',
  grain: 'One row per party.',
  table_type: 'dimension',
  columns: [{ column_name: 'party_key', data_type: 'BIGINT', nullable: false, description: 'Surrogate key.' }],
  relationships: [],
  ...over,
});
const catalog = (tables) => ({ schema_name: 'risk_mart', tables });
const messages = (result) => result.errors.join(' | ');

test('the bundled shape validates', () => {
  const result = validateCatalog(catalog([table()]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.tables, 1);
  assert.equal(result.summary.columns, 1);
});

test('a missing required field names the table and the field', () => {
  const result = validateCatalog(catalog([table({ grain: '' })]));
  assert.match(messages(result), /dim_party.*grain/);
});

test('duplicate table names are an error, not a silent overwrite', () => {
  // table_name becomes the document id, so the second would replace the first.
  const result = validateCatalog(catalog([table(), table()]));
  assert.match(messages(result), /duplicated/);
});

test('a relationship pointing outside the catalog is refused', () => {
  const result = validateCatalog(catalog([table({
    relationships: [{ from_table: 'dim_party', from_column: 'k', to_table: 'absent', to_column: 'k' }],
  })]));
  assert.match(messages(result), /"absent" is not in this catalog/);
});

test('a relationship to a table defined later still resolves', () => {
  // Forward references are normal in a generated catalog and must not fail.
  const result = validateCatalog(catalog([
    table({ table_name: 'fact_x', relationships: [{ from_table: 'fact_x', from_column: 'party_key', to_table: 'dim_party', to_column: 'party_key' }] }),
    table(),
  ]));
  assert.deepEqual(result.errors, []);
});

test('missing descriptions warn rather than fail, because the catalog still works', () => {
  const bare = table();
  delete bare.columns[0].description;
  const result = validateCatalog(catalog([bare]));
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(' '), /search_text/);
});

test('an empty or malformed catalog is rejected before anything else is checked', () => {
  assert.match(messages(validateCatalog(null)), /must be a JSON object/);
  assert.match(messages(validateCatalog({ tables: [] })), /non-empty "tables"/);
  assert.match(messages(validateCatalog({ tables: [table()], schema_name: 42 })), /schema_name/);
});

test('a table with no columns cannot be indexed and is an error', () => {
  assert.match(messages(validateCatalog(catalog([table({ columns: [] })]))), /"columns" is required/);
});

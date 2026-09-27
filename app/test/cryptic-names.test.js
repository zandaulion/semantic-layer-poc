import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { crypticCases, crypticCatalog, crypticRenameSql, rename } from '../eval/cryptic-names.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../banking-poc/catalog.json', import.meta.url), 'utf8'));

test('the bundled catalog abbreviates without collisions, tables or columns', () => {
  const { variant, tableMap } = crypticCatalog(catalog);
  assert.equal(variant.tables.length, catalog.tables.length);
  assert.equal(tableMap.get('fact_account_balance_daily'), 'F_ACCT_BAL_D');
  assert.equal(new Set(variant.tables.map((t) => t.table_name)).size, catalog.tables.length);
});

test('a collision fails rather than merging two tables', () => {
  const clash = { schema_name: 's', tables: [
    { table_name: 'fact_account', table_type: 'fact', domain: 'd', grain: 'g', columns: [] },
    { table_name: 'fact_acct', table_type: 'fact', domain: 'd', grain: 'g', columns: [] },
  ] };
  assert.throws(() => crypticCatalog(clash), /collision/);
});

test('the rename SQL renames every table and changed column, unquoted and in lower case', () => {
  const sql = crypticRenameSql(catalog);
  assert.match(sql, /ALTER TABLE bank_dwh\.fact_account_balance_daily RENAME TO f_acct_bal_d;/);
  assert.match(sql, /ALTER TABLE bank_dwh\.dim_customer RENAME COLUMN customer_key TO cust_k;/);
  assert.equal(sql.match(/RENAME TO/g).length, catalog.tables.length);
  assert.doesNotMatch(sql, /"/);
  // Columns are renamed before their table, while it still has its old name.
  assert.ok(sql.indexOf('dim_customer RENAME COLUMN') < sql.indexOf('dim_customer RENAME TO'));
});

test('expected tables are translated, cases without expectations pass through', () => {
  const { tableMap } = crypticCatalog(catalog);
  const [a, b] = crypticCases([{ id: 'a', expect: { required_tables: ['dim_customer'] } }, { id: 'b', reference: 'SELECT 1' }], tableMap);
  assert.deepEqual(a.expect.required_tables, ['D_CUST']);
  assert.deepEqual(b, { id: 'b', reference: 'SELECT 1' });
  assert.equal(rename('customer_key'), 'CUST_K');
});

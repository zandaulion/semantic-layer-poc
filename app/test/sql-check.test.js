import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSql, referencedTables } from '../server/sql-check.js';

test('a year filter written with EXTRACT does not invent a table', () => {
  // Regression: the reference scan read the column after EXTRACT's FROM as a
  // table, so a correct query came back needing revision.
  const sql = `SELECT COUNT(*) FROM bank_dwh.fact_complaint fc
    JOIN bank_dwh.dim_date dd ON fc.business_date_key = dd.date_key
    WHERE EXTRACT(YEAR FROM dd.calendar_date) = 2025`;
  assert.deepEqual(referencedTables(sql).unknown, []);
  assert.equal(checkSql(sql).tables, 'passed');
});

test('the other functions that borrow FROM and IN are handled too', () => {
  const sql = `SELECT SUBSTRING(c.display_name FROM 1 FOR 3), TRIM(BOTH ' ' FROM c.description),
    POSITION('x' IN c.business_code)
    FROM bank_dwh.dim_customer c`;
  const references = referencedTables(sql);
  assert.deepEqual(references.known, ['dim_customer']);
  assert.deepEqual(references.unknown, []);
});

test('a genuinely unknown table is still reported', () => {
  const sql = 'SELECT * FROM bank_dwh.dim_customer JOIN bank_dwh.not_a_table t ON t.id = 1';
  assert.deepEqual(referencedTables(sql).unknown, ['bank_dwh.not_a_table']);
  assert.equal(checkSql(sql).tables, 'needs_review');
});

test('a common table expression is not mistaken for a physical table', () => {
  const sql = `WITH recent AS (SELECT customer_key FROM bank_dwh.dim_customer)
    SELECT COUNT(*) FROM recent`;
  assert.deepEqual(referencedTables(sql).unknown, []);
  assert.equal(checkSql(sql).tables, 'passed');
});

test('a write disguised behind a CTE still fails the statement check', () => {
  // The model produced exactly this shape when asked to delete duplicates.
  const sql = `WITH ranked AS (
      SELECT customer_key, ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY updated_at DESC) AS rn
      FROM bank_dwh.dim_customer
    )
    DELETE FROM bank_dwh.dim_customer dc USING ranked r
    WHERE dc.customer_key = r.customer_key AND r.rn > 1`;
  assert.equal(checkSql(sql).statement, 'failed');
});

test('unbalanced parentheses do not hang or silently approve the remainder', () => {
  const sql = 'SELECT EXTRACT(YEAR FROM d.calendar_date FROM bank_dwh.dim_date d';
  const references = referencedTables(sql);
  assert.ok(Array.isArray(references.known));
  assert.equal(checkSql(sql).tables, 'needs_review');
});

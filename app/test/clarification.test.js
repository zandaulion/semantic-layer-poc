import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDraft, missingMonthYear } from '../server/model.js';

test('an unqualified August default question resolves the schema and asks only for the year', async () => {
  const hits = ['fact_loan_delinquency_daily', 'dim_customer', 'dim_date']
    .map((table_name) => ({ table_name }));
  const result = await generateDraft({ question: 'Clients in default at end of August', hits });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.clarification_question, 'Which year do you mean for the end of August?');
  assert.match(result.interpretation, /fact_loan_delinquency_daily\.default_flag/);
  assert.ok(result.sources.includes('table.bank_dwh.fact_loan_delinquency_daily'));
  assert.ok(result.retrieved_tables.some((table) => table.table_name === 'dim_date'));
});

test('an explicit or relative year resolves the date ambiguity', () => {
  assert.equal(missingMonthYear('Clients in default at end of August 2026'), null);
  assert.equal(missingMonthYear('Clients in default at end of August last year'), null);
});

test('a specified year produces a catalog-grounded client list with no invented date column', async () => {
  const hits = ['fact_loan_delinquency_daily', 'dim_customer', 'dim_date']
    .map((table_name) => ({ table_name }));
  const result = await generateDraft({ question: 'Clients in default at end of August 2026', hits });
  assert.equal(result.status, 'draft');
  assert.match(result.sql, /SELECT DISTINCT c\.business_id AS client_id, c\.display_name AS client_name/);
  assert.match(result.sql, /f\.default_flag = TRUE/);
  assert.match(result.sql, /calendar_year_number = 2026/);
  assert.doesNotMatch(result.sql, /is_business_day|current_active_customers/);
  assert.equal(result.checks.tables, 'passed');
  assert.equal(result.sources.length, 3);
});

test('last-month active customers uses the historical customer version at month end', async () => {
  const hits = ['dim_customer', 'dim_date', 'dim_account_relationship']
    .map((table_name) => ({ table_name }));
  const result = await generateDraft({ question: 'Number of active customers last month', hits });
  assert.equal(result.status, 'draft');
  assert.match(result.sql, /COUNT\(DISTINCT c\.business_id\)/);
  assert.match(result.sql, /c\.effective_from_date <= \(date_trunc\('month', CURRENT_DATE\)::date - 1\)/);
  assert.match(result.sql, /c\.effective_to_date > \(date_trunc\('month', CURRENT_DATE\)::date - 1\)/);
  assert.doesNotMatch(result.sql, /is_current|date_key|dim_account_relationship/);
  assert.equal(result.checks.tables, 'passed');
  assert.deepEqual(result.sources, ['table.bank_dwh.dim_customer']);
});

test('active customer transaction totals use catalog fields and state the missing-period assumption', async () => {
  const hits = ['fact_account_transaction', 'dim_customer', 'fact_payment_transaction']
    .map((table_name) => ({ table_name }));
  const result = await generateDraft({
    question: 'Number of active customers, and their total transaactions amount, per transaction type',
    hits,
  });
  assert.equal(result.status, 'draft');
  assert.match(result.sql, /fact_account_transaction/);
  assert.match(result.sql, /SUM\(t\.base_amount\)/);
  assert.match(result.sql, /COUNT\(DISTINCT historical_customer\.business_id\)/);
  assert.match(result.sql, /GROUP BY t\.transaction_type_code/);
  assert.doesNotMatch(result.sql, /fact_payment_transaction|fact_atm_transaction/);
  assert.ok(result.assumptions.some((assumption) => /No period was specified/.test(assumption)));
  assert.equal(result.checks.statement, 'passed');
  assert.equal(result.checks.tables, 'passed');
});

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

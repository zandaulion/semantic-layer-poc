import assert from 'node:assert/strict';
import test from 'node:test';
import { contextForHits } from '../server/catalog.js';
import { expandSearchQuery } from '../server/elastic.js';

test('client wording retrieves the customer dimension for an active count', () => {
  assert.equal(expandSearchQuery('Number of active clients today'), 'Number of active customer today');
  const hits = ['dim_customer', 'fact_customer_interaction', 'dim_account_status']
    .map((table_name) => ({ table_name }));
  const context = contextForHits('Number of active clients today', hits);
  assert.ok(context.tables.some((table) => table.table_name === 'dim_customer'));
});

test('loan repayment context includes declared customer and calendar joins despite domain filtering', () => {
  const hits = [
    'dim_loan_product', 'dim_loan_purpose', 'fact_loan_disbursement', 'fact_loan_repayment',
    'fact_loan_application', 'fact_loan_balance_daily', 'fact_loan_interest_accrual',
    'fact_loan_delinquency_daily', 'fact_loan_loss_provision',
  ].map((table_name) => ({ table_name }));
  const context = contextForHits('Show loan repayments by customer for the first week of January 2026', hits);
  const names = new Set(context.tables.map((table) => table.table_name));
  assert.ok(names.has('fact_loan_repayment'));
  assert.ok(names.has('dim_customer'));
  assert.ok(names.has('dim_date'));
  assert.ok(context.tables.length <= 8);
  assert.ok(context.relationships.some((relation) => relation.from_table === 'fact_loan_repayment' && relation.to_table === 'dim_date'));
});

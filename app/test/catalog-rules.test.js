import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'server');

/**
 * Drafts a question against a given catalog with no model configured.
 *
 * With no key the model call is refused, so the reply distinguishes the two
 * paths cleanly: a deterministic catalog rule answers with model
 * "catalog_rule", and anything that falls through returns
 * "model_unconfigured". No network, no Elasticsearch, no model.
 */
function draftWithoutModel(catalog, question, hitNames) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rules-'));
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify(catalog));
  const env = { ...process.env, CATALOG_PATH: file };
  delete env.MODEL_API_KEY;
  delete env.GROQ_API_KEY;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { generateDraft } = await import('./model.js');
    const hits = ${JSON.stringify(hitNames)}.map((table_name) => ({ table_name }));
    const draft = await generateDraft({ question: ${JSON.stringify(question)}, hits });
    console.log(JSON.stringify({ status: draft.status, code: draft.code, model: draft.model }));
  `], { env, cwd: serverDir, encoding: 'utf8' });
  return JSON.parse(output.trim());
}

/** The three tables the month-end default rule requires, named either way. */
function defaultCatalog({ crypticColumns }) {
  const col = (readable, abbreviated) => (crypticColumns ? abbreviated : readable);
  const columns = (names) => names.map(([readable, abbreviated]) => ({
    column_name: col(readable, abbreviated), data_type: 'BIGINT', description: `${readable}.`,
  }));
  return {
    schema_name: 'bank_dwh',
    tables: [
      {
        table_name: 'fact_loan_delinquency_daily', table_type: 'fact', domain: 'lending',
        grain: 'One row per loan delinquency per business date.',
        columns: columns([['default_flag', 'DFLT_FLG'], ['customer_key', 'CUST_K'], ['business_date_key', 'BUS_DT_K']]),
        relationships: [],
      },
      {
        table_name: 'dim_date', table_type: 'dimension', domain: 'conformed',
        grain: 'One row per calendar date.',
        columns: columns([['date_key', 'DT_K'], ['calendar_date', 'CAL_DT'],
          ['calendar_year_number', 'CAL_YR_NBR'], ['month_number', 'MTH_NBR']]),
        relationships: [],
      },
      {
        table_name: 'dim_customer', table_type: 'dimension', domain: 'conformed',
        grain: 'One row per version of a customer.',
        columns: columns([['customer_key', 'CUST_K'], ['business_id', 'BUS_ID'], ['display_name', 'DSPLY_NM']]),
        relationships: [],
      },
    ],
  };
}

const QUESTION = 'How many clients were in default at the end of August 2025?';
const HITS = ['fact_loan_delinquency_daily', 'dim_date', 'dim_customer'];

test('the deterministic rule answers when the catalog has the columns it names', () => {
  const draft = draftWithoutModel(defaultCatalog({ crypticColumns: false }), QUESTION, HITS);
  assert.equal(draft.model, 'catalog_rule');
  assert.equal(draft.status, 'draft');
});

test('cryptic column names make the rule stand down rather than answer wrongly', () => {
  // Same tables, same question, columns abbreviated the way a real warehouse
  // abbreviates them. The rule names its columns as literals, so it cannot
  // apply here -- and the behaviour that matters is that it declines and lets
  // the model try, instead of throwing or emitting SQL for columns that do not
  // exist. Every such rule will be in this position on a real catalog.
  const draft = draftWithoutModel(defaultCatalog({ crypticColumns: true }), QUESTION, HITS);
  assert.notEqual(draft.model, 'catalog_rule');
  assert.equal(draft.code, 'model_unconfigured', 'should have fallen through to the model');
});

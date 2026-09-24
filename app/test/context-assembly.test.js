import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'server');

function contextTablesFor(catalog, question, hitNames) {
  const dir = mkdtempSync(path.join(tmpdir(), 'context-'));
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify(catalog));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { contextForHits } = await import('./catalog.js');
    const hits = ${JSON.stringify(hitNames)}.map((table_name) => ({ table_name }));
    const context = contextForHits(${JSON.stringify(question)}, hits);
    console.log(JSON.stringify(context.tables.map((t) => t.table_name)));
  `], { env: { ...process.env, CATALOG_PATH: file }, cwd: serverDir, encoding: 'utf8' });
  return JSON.parse(output.trim());
}

/** A fact joined to a date dimension and several others, named either way. */
function starSchema({ cryptic }) {
  const name = (readable, abbreviated) => (cryptic ? abbreviated : readable);
  const date = name('dim_date', 'D_DT');
  const other = name('dim_channel', 'D_CHNL');
  const fact = name('fact_wire_transfer', 'F_WR_TRF');
  const column = (readable, abbreviated) => (cryptic ? abbreviated : readable);

  const dimension = (table_name, grain) => ({
    table_name, table_type: 'dimension', domain: 'conformed', grain,
    columns: [{ column_name: column('business_key', 'BUS_K'), data_type: 'BIGINT', description: 'Key.' }],
    relationships: [],
  });

  // Extra facts exist so the date dimension has the highest join degree, the
  // structural signal that stands in for "conformed dimension".
  const extraFacts = ['a', 'b', 'c'].map((suffix) => ({
    table_name: `${fact}_${suffix}`, table_type: 'fact', domain: 'payments', grain: 'One row per event.',
    columns: [{ column_name: column('business_date_key', 'BUS_DT_K'), data_type: 'BIGINT', description: 'Date.' }],
    relationships: [{ from_table: `${fact}_${suffix}`, from_column: column('business_date_key', 'BUS_DT_K'), to_table: date, to_column: column('date_key', 'DT_K') }],
  }));

  return {
    schema_name: 'mart',
    tables: [
      dimension(date, 'One row per calendar date.'),
      dimension(other, 'One row per channel.'),
      {
        table_name: fact, table_type: 'fact', domain: 'payments', grain: 'One row per wire transfer.',
        columns: [{ column_name: column('business_date_key', 'BUS_DT_K'), data_type: 'BIGINT', description: 'Date of the transfer.' }],
        relationships: [
          // Declared before the date join on purpose: ordering must not decide.
          { from_table: fact, from_column: column('channel_key', 'CHNL_K'), to_table: other, to_column: column('business_key', 'BUS_K') },
          { from_table: fact, from_column: column('business_date_key', 'BUS_DT_K'), to_table: date, to_column: column('date_key', 'DT_K') },
        ],
      },
      ...extraFacts,
    ],
  };
}

test('a readable date dimension reaches the prompt', () => {
  const tables = contextTablesFor(starSchema({ cryptic: false }), 'Total wire transfers in 2025', ['fact_wire_transfer']);
  assert.ok(tables.includes('fact_wire_transfer'));
  assert.ok(tables.includes('dim_date'), `expected dim_date in ${tables.join(', ')}`);
});

test('an abbreviated date dimension reaches the prompt too', () => {
  // Regression: selection scored dimensions by word overlap with the question
  // and gave a bonus to the literal name "dim_date", so a catalog using
  // bank-style abbreviations scored every dimension zero and supplied none of
  // them -- the draft lost its joins although search had found the fact.
  const tables = contextTablesFor(starSchema({ cryptic: true }), 'Total wire transfers in 2025', ['F_WR_TRF']);
  assert.ok(tables.includes('F_WR_TRF'));
  assert.ok(tables.includes('D_DT'), `expected D_DT in ${tables.join(', ')}`);
});

test('the context stays within its table budget', () => {
  const tables = contextTablesFor(starSchema({ cryptic: true }), 'Total wire transfers in 2025', ['F_WR_TRF']);
  assert.ok(tables.length <= 8, `context of ${tables.length} tables exceeds the cap`);
  assert.equal(new Set(tables).size, tables.length, 'no table should appear twice');
});

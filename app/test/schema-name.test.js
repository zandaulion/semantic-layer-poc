import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'server');

// The schema name is resolved once when the catalog module is first imported,
// so exercising a different one means a separate process rather than a reload.
function withCatalog(catalog, script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify(catalog));
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CATALOG_PATH: file },
    cwd: serverDir,
    encoding: 'utf8',
  }).trim();
}

const catalogFor = (schema) => ({
  schema_name: schema,
  tables: [{
    table_name: 'dim_party',
    table_type: 'dimension',
    domain: 'conformed',
    grain: 'One row per party.',
    columns: [{ column_name: 'party_key', data_type: 'BIGINT', nullable: false, description: 'Surrogate key.' }],
    relationships: [],
  }],
});

test('documents are identified by the schema the catalog declares', () => {
  const output = withCatalog(catalogFor('risk_mart'), `
    const { tableDocument, tables, schemaName } = await import('./catalog.js');
    const doc = tableDocument(tables[0]);
    console.log(JSON.stringify({ schemaName, id: doc.document_id, title: doc.title }));
  `);
  const { schemaName, id, title } = JSON.parse(output);
  assert.equal(schemaName, 'risk_mart');
  assert.equal(id, 'table.risk_mart.dim_party');
  assert.match(title, /risk_mart\.dim_party/);
});

test('the safety check accepts the declared schema and rejects another', () => {
  const output = withCatalog(catalogFor('risk_mart'), `
    const { checkSql } = await import('./sql-check.js');
    console.log(JSON.stringify({
      own: checkSql('SELECT * FROM risk_mart.dim_party').tables,
      foreign: checkSql('SELECT * FROM bank_dwh.dim_party').tables,
      bare: checkSql('SELECT * FROM dim_party').tables,
    }));
  `);
  const result = JSON.parse(output);
  assert.equal(result.own, 'passed');
  // A table of the same name in a schema the catalog does not describe is not
  // the table the catalog describes.
  assert.equal(result.foreign, 'needs_review');
  // An unqualified name is resolved against the declared schema, not bank_dwh.
  assert.equal(result.bare, 'passed');
});

test('an uppercase catalog accepts a draft written in either case', () => {
  // Regression: references were lower-cased before lookup while the catalog was
  // keyed by its own spelling, so every correct draft against a warehouse with
  // uppercase physical names -- the common case outside this fixture -- came
  // back as touching an unknown table.
  const upper = catalogFor('BANK_DWH');
  upper.tables[0].table_name = 'D_CUST';
  const output = withCatalog(upper, `
    const { checkSql, referencedTables } = await import('./sql-check.js');
    console.log(JSON.stringify({
      asDeclared: checkSql('SELECT * FROM BANK_DWH.D_CUST').tables,
      lowered: checkSql('SELECT * FROM bank_dwh.d_cust').tables,
      mixed: checkSql('SELECT * FROM Bank_Dwh.D_Cust').tables,
      reported: referencedTables('SELECT * FROM bank_dwh.d_cust').known,
    }));
  `);
  const result = JSON.parse(output);
  assert.equal(result.asDeclared, 'passed');
  assert.equal(result.lowered, 'passed');
  assert.equal(result.mixed, 'passed');
  // Reported under the catalog's spelling, whatever the draft used.
  assert.deepEqual(result.reported, ['D_CUST']);
});

test('a catalog that declares no schema still falls back to the fixture default', () => {
  const catalog = catalogFor('ignored');
  delete catalog.schema_name;
  const output = withCatalog(catalog, `
    const { schemaName } = await import('./catalog.js');
    console.log(schemaName);
  `);
  assert.equal(output, 'bank_dwh');
});

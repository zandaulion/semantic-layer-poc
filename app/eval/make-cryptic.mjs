/**
 * Builds a variant of the fixture whose names look like a real bank warehouse.
 *
 * Retrieval boosts table_name by six and column_names by three. The bundled
 * fixture spells everything out -- `fact_account_balance_daily` -- so those
 * boosts land on words a person would actually type. Warehouses that grew out
 * of a mainframe rarely do; they carry `F_ACCT_BAL_D`, and the boosted fields
 * stop matching the question.
 *
 * This rewrites names through a consistent abbreviation map and translates the
 * evaluation's expected tables through the same map, so the cases still assert
 * the same thing about the same tables. Grain and column descriptions are left
 * alone by default, which makes the pair of runs measure the cost of the names
 * alone; --strip-prose also flattens those, which measures what curated
 * descriptions were buying.
 *
 *   node eval/make-cryptic.mjs --out DIR [--strip-prose]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.js';
import { crypticCases, crypticCatalog } from './cryptic-names.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const outDir = flag('--out');
const stripProse = argv.includes('--strip-prose');
if (!outDir) {
  console.error('Usage: node eval/make-cryptic.mjs --out DIR [--strip-prose]');
  process.exit(2);
}

const catalog = JSON.parse(await readFile(config.catalogPath, 'utf8'));
let built;
try {
  built = crypticCatalog(catalog, { stripProse });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { variant, tableMap } = built;

// The questions stay in business English -- that is the whole point. Only the
// expected table names move, so each case still asserts the same thing.
const { cases, notes } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
const variantCases = {
  notes: [...notes, `Table names rewritten by make-cryptic.mjs${stripProse ? ' with --strip-prose' : ''}.`],
  cases: crypticCases(cases, tableMap),
};

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'catalog.json'), `${JSON.stringify(variant, null, 2)}\n`);
await writeFile(path.join(outDir, 'cases.json'), `${JSON.stringify(variantCases, null, 2)}\n`);
await writeFile(path.join(outDir, 'name-map.json'), `${JSON.stringify(Object.fromEntries(tableMap), null, 2)}\n`);

console.log(`  ${outDir}`);
console.log(`  ${variant.tables.length} tables, prose ${stripProse ? 'stripped' : 'kept'}`);
for (const name of ['dim_customer', 'fact_account_balance_daily', 'fact_loan_delinquency_daily']) {
  if (tableMap.has(name)) console.log(`    ${name} -> ${tableMap.get(name)}`);
}

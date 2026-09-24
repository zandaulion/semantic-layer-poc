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

const here = path.dirname(fileURLToPath(import.meta.url));

// Chosen to look like abbreviations a bank actually uses, and checked for
// collisions after the fact rather than assumed to be unique.
const WORDS = {
  fact: 'F', dim: 'D',
  account: 'ACCT', customer: 'CUST', transaction: 'TXN', balance: 'BAL',
  payment: 'PMT', product: 'PRD', security: 'SEC', position: 'POS',
  currency: 'CCY', merchant: 'MRCH', category: 'CTG', portfolio: 'PTF',
  instrument: 'INSTR', settlement: 'STLM', delinquency: 'DLQ', collateral: 'COLL',
  repayment: 'RPMT', regulatory: 'REG', compliance: 'CMPL', valuation: 'VAL',
  authorization: 'AUTH', organization: 'ORG', jurisdiction: 'JUR',
  relationship: 'REL', interaction: 'INTRC', campaign: 'CMPG', response: 'RESP',
  complaint: 'CMPLT', exposure: 'EXPO', liquidity: 'LIQ', treasury: 'TRSY',
  allocation: 'ALLOC', chargeback: 'CHBK', dispute: 'DSPT', reward: 'RWD',
  earning: 'ERN', benchmark: 'BMK', household: 'HHLD', employee: 'EMPL',
  interest: 'INT', credit: 'CR', card: 'CD', loan: 'LN', deposit: 'DEP',
  branch: 'BR', channel: 'CHNL', daily: 'D', monthly: 'M', date: 'DT',
  rate: 'RT', type: 'TYP', status: 'STS', code: 'CD1', key: 'K', amount: 'AMT',
  number: 'NBR', name: 'NM', description: 'DSC', value: 'VAL1', flag: 'FLG',
  business: 'BUS', effective: 'EFF', updated: 'UPD', ingested: 'INGST',
  source: 'SRC', system: 'SYS', record: 'REC', version: 'VRSN', hash: 'HSH',
  quality: 'QLY', reference: 'REF', current: 'CURR', active: 'ACTV',
  identifier: 'ID', term: 'TRM', plan: 'PLN', band: 'BND', model: 'MDL',
  scenario: 'SCN', alert: 'ALRT', fraud: 'FRD', rule: 'RUL', report: 'RPT',
  general: 'GEN', ledger: 'LDGR', entry: 'ENTR', trade: 'TRD', market: 'MKT',
  wire: 'WR', transfer: 'TRF', standing: 'STDG', order: 'ORD',
  execution: 'EXEC', direct: 'DIR', debit: 'DBT', return: 'RTN',
  clearing: 'CLR', terminal: 'TRML', network: 'NTWK', usage: 'USG',
  limit: 'LMT', accrual: 'ACCR', loss: 'LOSS', fee: 'FEE', hold: 'HLD',
  service: 'SVC', case: 'CS', digital: 'DGTL', session: 'SESN',
  corporate: 'CORP', action: 'ACTN', investment: 'INVST', purpose: 'PRPS',
  facility: 'FCLTY', rating: 'RTG', aml: 'AML', fx: 'FX', gl: 'GL',
  party: 'PTY', snapshot: 'SNAP', calendar: 'CAL', day: 'DY', week: 'WK',
  month: 'MTH', quarter: 'QTR', year: 'YR', ordinal: 'ORDNL', base: 'BS',
};

/** Deterministic, so the same token abbreviates the same way everywhere. */
function shorten(word) {
  if (WORDS[word]) return WORDS[word];
  if (/^\d+$/.test(word)) return word;
  if (word.length <= 3) return word.toUpperCase();
  // Keep the first letter and the consonants after it: a crude but stable rule,
  // and close to what hand-abbreviated warehouses actually look like.
  const squeezed = word[0] + word.slice(1).replace(/[aeiou]/g, '');
  return (squeezed.length >= 3 ? squeezed.slice(0, 5) : word.slice(0, 4)).toUpperCase();
}

const rename = (name) => name.split('_').map(shorten).join('_');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const outDir = flag('--out');
const stripProse = argv.includes('--strip-prose');
if (!outDir) {
  console.error('Usage: node eval/make-cryptic.mjs --out DIR [--strip-prose]');
  process.exit(2);
}

const catalog = JSON.parse(await readFile(config.catalogPath, 'utf8'));
const tableMap = new Map();
for (const table of catalog.tables) tableMap.set(table.table_name, rename(table.table_name));

// A collision would merge two tables into one document and quietly change what
// the experiment is measuring, so it fails rather than being worked around.
const collisions = new Map();
for (const [original, renamed] of tableMap) {
  if (!collisions.has(renamed)) collisions.set(renamed, []);
  collisions.get(renamed).push(original);
}
const clashing = [...collisions].filter(([, names]) => names.length > 1);
if (clashing.length) {
  console.error('Abbreviation collisions:');
  for (const [renamed, names] of clashing) console.error(`  ${renamed} <- ${names.join(', ')}`);
  process.exit(1);
}

const variant = {
  schema_name: catalog.schema_name,
  tables: catalog.tables.map((table) => ({
    table_name: tableMap.get(table.table_name),
    table_type: table.table_type,
    domain: table.domain,
    grain: stripProse ? 'One row per record.' : table.grain,
    columns: table.columns.map((column) => ({
      column_name: rename(column.column_name),
      data_type: column.data_type,
      nullable: column.nullable,
      ...(stripProse ? {} : { description: column.description }),
    })),
    relationships: (table.relationships ?? []).map((relation) => ({
      from_table: tableMap.get(relation.from_table) ?? rename(relation.from_table),
      from_column: rename(relation.from_column),
      to_table: tableMap.get(relation.to_table) ?? rename(relation.to_table),
      to_column: rename(relation.to_column),
    })),
  })),
};

// The questions stay in business English -- that is the whole point. Only the
// expected table names move, so each case still asserts the same thing.
const { cases, notes } = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8'));
const translate = (names) => (names ?? []).map((name) => tableMap.get(name) ?? rename(name));
const variantCases = {
  notes: [...notes, `Table names rewritten by make-cryptic.mjs${stripProse ? ' with --strip-prose' : ''}.`],
  cases: cases.map((testCase) => ({
    ...testCase,
    expect: {
      ...testCase.expect,
      ...(testCase.expect.required_tables ? { required_tables: translate(testCase.expect.required_tables) } : {}),
      ...(testCase.expect.preferred_tables ? { preferred_tables: translate(testCase.expect.preferred_tables) } : {}),
      ...(testCase.expect.forbidden_tables ? { forbidden_tables: translate(testCase.expect.forbidden_tables) } : {}),
    },
  })),
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

/**
 * The abbreviation rule behind the cryptic catalog: names rewritten the way a
 * warehouse that grew out of a mainframe spells them, `fact_account_balance_daily`
 * becoming `F_ACCT_BAL_D`. make-cryptic.mjs writes a variant catalog with it,
 * and the model benchmark uses it to run the same questions against the same
 * data under those names.
 */

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
export function shorten(word) {
  if (WORDS[word]) return WORDS[word];
  if (/^\d+$/.test(word)) return word;
  if (word.length <= 3) return word.toUpperCase();
  // Keep the first letter and the consonants after it: a crude but stable rule,
  // and close to what hand-abbreviated warehouses actually look like.
  const squeezed = word[0] + word.slice(1).replace(/[aeiou]/g, '');
  return (squeezed.length >= 3 ? squeezed.slice(0, 5) : word.slice(0, 4)).toUpperCase();
}

export const rename = (name) => name.split('_').map(shorten).join('_');


/**
 * The catalog under cryptic names, and the map from each table's name to its
 * new one. Grain and column descriptions are kept unless `stripProse`, which
 * flattens them too. Throws on an abbreviation collision: two tables merged
 * into one would quietly change what is being measured.
 */
export function crypticCatalog(catalog, { stripProse = false } = {}) {
  const tableMap = new Map();
  for (const table of catalog.tables) tableMap.set(table.table_name, rename(table.table_name));
  const collisions = new Map();
  for (const [original, renamed] of tableMap) {
    if (!collisions.has(renamed)) collisions.set(renamed, []);
    collisions.get(renamed).push(original);
  }
  const clashing = [...collisions].filter(([, names]) => names.length > 1);
  if (clashing.length) {
    throw new Error(`Abbreviation collisions:\n${clashing.map(([renamed, names]) => `  ${renamed} <- ${names.join(', ')}`).join('\n')}`);
  }
  const columnClash = catalog.tables.find((table) => new Set(table.columns.map((c) => rename(c.column_name))).size !== table.columns.length);
  if (columnClash) throw new Error(`Abbreviation collision among the columns of ${columnClash.table_name}`);

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
  return { variant, tableMap };
}

/** Cases whose expected tables are translated through the same map. */
export function crypticCases(cases, tableMap) {
  const translate = (names) => (names ?? []).map((name) => tableMap.get(name) ?? rename(name));
  return cases.map((testCase) => ({
    ...testCase,
    ...(testCase.expect ? {
      expect: {
        ...testCase.expect,
        ...(testCase.expect.required_tables ? { required_tables: translate(testCase.expect.required_tables) } : {}),
        ...(testCase.expect.preferred_tables ? { preferred_tables: translate(testCase.expect.preferred_tables) } : {}),
        ...(testCase.expect.forbidden_tables ? { forbidden_tables: translate(testCase.expect.forbidden_tables) } : {}),
      },
    } : {}),
  }));
}

/**
 * SQL that renames a loaded copy of the warehouse to the cryptic names, in
 * place. Unquoted, so PostgreSQL stores them in lower case and a draft finds
 * them whether it writes F_ACCT_BAL_D or f_acct_bal_d, as it would on a
 * warehouse whose names are case-insensitive.
 */
export function crypticRenameSql(catalog) {
  const schema = catalog.schema_name;
  const lines = [];
  for (const table of catalog.tables) {
    for (const column of table.columns) {
      const renamed = rename(column.column_name).toLowerCase();
      if (renamed !== column.column_name) lines.push(`ALTER TABLE ${schema}.${table.table_name} RENAME COLUMN ${column.column_name} TO ${renamed};`);
    }
    lines.push(`ALTER TABLE ${schema}.${table.table_name} RENAME TO ${rename(table.table_name).toLowerCase()};`);
  }
  return `${lines.join('\n')}\n`;
}

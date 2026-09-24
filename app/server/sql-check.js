import { tableByLowerName, schemaName } from './catalog.js';

function withoutQuotedContent(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

// Standard SQL borrows FROM and IN as argument separators inside a handful of
// functions -- EXTRACT(YEAR FROM d.calendar_date), SUBSTRING(s FROM 2),
// TRIM(BOTH ' ' FROM s). A scan that does not know this reads the column after
// FROM as a table name and reports a correct query as touching an unknown one,
// which is how a valid year filter ended up flagged for revision. Removing
// those call bodies first is cheaper and steadier than teaching the scan SQL.
const KEYWORD_ARGUMENT_CALL = /\b(?:EXTRACT|SUBSTRING|TRIM|OVERLAY|POSITION)\s*\(/i;

function withoutKeywordArgumentCalls(sql) {
  let result = sql;
  for (;;) {
    const match = KEYWORD_ARGUMENT_CALL.exec(result);
    if (!match) return result;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < result.length; index += 1) {
      if (result[index] === '(') depth += 1;
      else if (result[index] === ')' && --depth === 0) { close = index; break; }
    }
    // Unbalanced parentheses mean the rest cannot be read reliably; dropping it
    // is the conservative choice, since a reference that is never seen is
    // reported as unverifiable rather than as approved.
    if (close === -1) return result.slice(0, match.index);
    result = `${result.slice(0, match.index)} ${result.slice(close + 1)}`;
  }
}

/**
 * Physical tables a draft reads from, split into those the catalog knows and
 * those it does not. Common table expressions are resolved away rather than
 * reported as unknown tables.
 *
 * Exported because grounding evaluation asks the same question the safety check
 * does -- which tables did this draft actually touch -- and two regexes that
 * drift apart would quietly disagree about the answer.
 */
export function referencedTables(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { known: [], unknown: [] };
  const body = withoutKeywordArgumentCalls(withoutQuotedContent(sql).trim().replace(/;\s*$/, '').trim());
  const cteNames = new Set([...body.matchAll(/\b(?:WITH|,)\s*([a-z_][\w]*)\s+AS\s*\(/gi)]
    .map((match) => match[1].toLowerCase()));
  const known = [];
  const unknown = [];
  for (const reference of [...body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/gi)].map((match) => match[1].toLowerCase())) {
    if (cteNames.has(reference)) continue;
    const [schema, table] = reference.includes('.') ? reference.split('.', 2) : [schemaName.toLowerCase(), reference];
    const match = schema === schemaName.toLowerCase() ? tableByLowerName.get(table) : undefined;
    // Reported under the catalog's own spelling, so downstream comparisons see
    // one name per table rather than whichever case the draft happened to use.
    if (match) known.push(match.table_name);
    else unknown.push(reference);
  }
  return { known: [...new Set(known)], unknown: [...new Set(unknown)] };
}

export function checkSql(sql) {
  const findings = [];
  if (typeof sql !== 'string' || !sql.trim()) {
    return { statement: 'failed', tables: 'not_checked', syntax: 'not_verified', business: 'not_verified', execution: 'not_run', findings: ['No SQL was returned.'] };
  }
  const stripped = withoutQuotedContent(sql).trim();
  const body = stripped.replace(/;\s*$/, '').trim();
  const semicolons = (body.match(/;/g) || []).length;
  if (semicolons || !/^(SELECT|WITH)\b/i.test(body)) {
    findings.push('The draft must contain one SELECT or WITH query.');
  }
  if (/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|COPY|DO|EXECUTE|VACUUM|ANALYZE)\b/i.test(body)
      || /\bFOR\s+(UPDATE|SHARE)\b/i.test(body)
      || /\bSELECT\b[\s\S]*?\bINTO\b/i.test(body)) {
    findings.push('The draft contains a statement or clause outside the read-only POC scope.');
  }
  const { known, unknown } = referencedTables(sql);
  const references = [...known, ...unknown];
  if (!references.length) findings.push('No physical table reference could be checked.');
  if (unknown.length) findings.push(`Unknown or out-of-scope table reference: ${[...new Set(unknown)].join(', ')}.`);
  return {
    statement: findings.some((item) => item.includes('read-only') || item.includes('one SELECT')) ? 'failed' : 'passed',
    tables: unknown.length || !references.length ? 'needs_review' : 'passed',
    syntax: 'not_verified',
    columns: 'not_verified',
    business: 'not_verified',
    execution: 'not_run',
    findings,
  };
}

import { tableByName } from './catalog.js';

function withoutQuotedContent(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
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
  const cteNames = new Set([...body.matchAll(/\b(?:WITH|,)\s*([a-z_][\w]*)\s+AS\s*\(/gi)].map((match) => match[1].toLowerCase()));
  const references = [...body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/gi)].map((match) => match[1].toLowerCase());
  const unknown = references.filter((ref) => {
    if (cteNames.has(ref)) return false;
    const [schema, table] = ref.includes('.') ? ref.split('.', 2) : ['bank_dwh', ref];
    return schema !== 'bank_dwh' || !tableByName.has(table);
  });
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

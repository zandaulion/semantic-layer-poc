/**
 * Running a draft against the warehouse, read-only.
 *
 * Three layers, so that no single one has to be right: the statement check
 * refuses anything but one SELECT or WITH; the database user can only read
 * and runs every transaction read-only with a statement timeout (set on the
 * role, see deploy/warehouse); and the query is wrapped in a row limit, so a
 * cross join returns a page, not the warehouse.
 */

import { config } from './config.js';
import { pgQuery } from './pg-client.js';
import { checkSql } from './sql-check.js';

export const warehouseConfigured = () => Boolean(config.dwhUrl);

/**
 * Checks a draft without running it: EXPLAIN parses it, resolves every table
 * and column, and plans it, and returns no rows. Resolves the query's output
 * columns, or the warehouse's error, in the shape runWarehouseQuery uses.
 */
export async function explainWarehouseQuery(sql, { url = config.dwhUrl } = {}) {
  if (!url) return { ok: false, error: 'No warehouse is configured on this server.' };
  const checks = checkSql(sql);
  if (checks.statement === 'failed') return { ok: false, error: checks.findings.join(' ') };
  const body = String(sql).trim().replace(/;\s*$/, '');
  const started = Date.now();
  try {
    const { rows } = await pgQuery(url, `EXPLAIN (VERBOSE, FORMAT JSON) ${body}`);
    const plan = JSON.parse(rows[0][0])[0].Plan;
    return { ok: true, explain_only: true, columns: plan.Output ?? [], note: 'Valid: the query parses and every table and column exists. EXPLAIN only, so no rows are shown.', ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 300), ms: Date.now() - started };
  }
}

export async function runWarehouseQuery(sql, { maxRows = config.dwhMaxRows, url = config.dwhUrl } = {}) {
  if (!url) return { ok: false, error: 'No warehouse is configured on this server.' };
  const checks = checkSql(sql);
  if (checks.statement === 'failed') return { ok: false, error: checks.findings.join(' ') };
  const body = String(sql).trim().replace(/;\s*$/, '');
  const started = Date.now();
  try {
    const { columns, rows } = await pgQuery(url, `SELECT * FROM (\n${body}\n) AS result LIMIT ${maxRows + 1}`);
    return { ok: true, columns, rows: rows.slice(0, maxRows), row_count: Math.min(rows.length, maxRows), truncated: rows.length > maxRows, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 300), ms: Date.now() - started };
  }
}

/**
 * What running a draft proved. The statement check can only say a draft looks
 * read-only and names known tables; a warehouse that ran it has also checked
 * its syntax and every column it names. A failure proves none of that.
 */
export function checksAfterExecution(checks, execution) {
  if (!checks || !execution) return checks;
  return execution.ok
    ? { ...checks, syntax: 'passed', columns: 'passed', execution: 'passed' }
    : { ...checks, execution: 'failed', findings: [...(checks.findings ?? []), `The warehouse refused it: ${execution.error}`] };
}

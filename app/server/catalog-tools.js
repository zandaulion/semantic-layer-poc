/**
 * The lookups the agent can make: a fuzzy search over the table index, and
 * reading one table's YAML. Both read the files catalog-files.js writes, never
 * the catalog in memory, so the agent sees exactly what a deployment that
 * maintains those files by hand would give it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureCatalogFiles } from './catalog-files.js';

let loaded = null;

function catalog() {
  if (loaded) return loaded;
  const dir = ensureCatalogFiles();
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'table-index.json'), 'utf8'));
  const entries = index.tables.map((entry) => ({
    entry,
    fields: [
      [3, tokens(entry.table)],
      [2, tokens(entry.grain)],
      [1.5, tokens(entry.columns.join(' '))],
      [1, tokens(entry.descriptions)],
    ].map(([weight, list]) => [weight, new Set(list)]),
  }));
  // How rare each token is across tables: "key" and "date" are in nearly
  // every table and say little about which one a question needs.
  const documentFrequency = new Map();
  for (const { fields } of entries) {
    for (const token of new Set(fields.flatMap(([, set]) => [...set]))) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const lowerNames = new Map(index.tables.map((entry) => [entry.table.toLowerCase(), entry.table]));
  loaded = { dir, schema: index.schema, entries, documentFrequency, lowerNames };
  return loaded;
}

export function catalogSchema() {
  return catalog().schema;
}

// Underscores split, so F_ACCT_BAL_D gives f, acct, bal, d; a crude plural fold
// so "balances" meets "balance".
function tokens(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((word) => word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
}

const trigramCache = new Map();

function trigrams(word) {
  const cached = trigramCache.get(word);
  if (cached) return cached;
  const padded = `  ${word} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  trigramCache.set(word, set);
  return set;
}

// "acct" for "account", "bal" for "balance", "dlq" for "delinquency": the
// letters of an abbreviation appear in order in the word it stands for, and
// start with its first letter.
function isAbbreviation(short, long) {
  if (short.length < 2 || short.length >= long.length || short[0] !== long[0]) return false;
  let at = 0;
  for (const letter of long) if (letter === short[at]) at += 1;
  return at === short.length;
}

/** How well one question word matches one catalog word, from 0 to 1. */
function similarity(query, word) {
  if (query === word) return 1;
  // Four letters at least: "app" is a prefix of "application" and of nothing
  // a question about the mobile app means.
  if (query.length >= 4 && word.length >= 4 && (word.startsWith(query) || query.startsWith(word))) return 0.8;
  if (query.length >= 3 && isAbbreviation(word, query)) return 0.6;
  if (query.length < 4 || word.length < 4) return 0;
  const a = trigrams(query);
  const b = trigrams(word);
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  const dice = (2 * shared) / (a.size + b.size);
  return dice >= 0.5 ? dice * 0.7 : 0;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'by', 'in', 'on', 'and', 'or', 'to', 'per', 'with', 'what', 'which', 'show', 'list', 'how', 'many', 'much', 'is', 'are', 'was', 'were', 'me', 'all', 'each', 'from', 'at', 'as', 'their', 'there', 'that', 'this', 'get', 'give', 'find', 'number', 'count', 'total']);

/**
 * `domain` filters: the user chose that subject area. `preferDomain` only
 * ranks: the model guessed it, and a guess must not hide a table filed
 * elsewhere -- card authorizations sit under payments in this catalog, and a
 * model that asked for "cards" never saw them.
 */
export function searchCatalog(query, { domain, preferDomain, type, limit = 10 } = {}) {
  const { entries, documentFrequency } = catalog();
  const words = [...new Set(tokens(query).filter((word) => !STOP.has(word)))];
  if (!words.length) return [];
  const total = entries.length;
  const results = [];
  for (const { entry, fields } of entries) {
    if (domain && entry.domain !== domain) continue;
    if (type && entry.type !== type) continue;
    let score = 0;
    for (const word of words) {
      // Summed across fields, best match within each: a word in a table's
      // name and in its columns says more than a word in its name alone.
      let best = 0;
      for (const [weight, set] of fields) {
        let field = 0;
        if (set.has(word)) field = 1;
        else for (const candidate of set) field = Math.max(field, similarity(word, candidate));
        best += field * weight;
      }
      // Weighted by the rarest exact spelling of the word, which keeps
      // "customer" from outranking "delinquency" in "customers in delinquency".
      // A word the catalog never spells exactly ("client", "August") can only
      // match loosely, so it is weighted as a middling word, not the rarest.
      const df = documentFrequency.get(word) ?? total / 10;
      score += best * Math.log(1 + total / df);
    }
    if (preferDomain && entry.domain === preferDomain) score *= 1.25;
    if (score > 0) results.push({ entry, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(25, limit)))
    .map(({ entry, score }) => ({ table: entry.table, type: entry.type, domain: entry.domain, grain: entry.grain, score: Math.round(score * 10) / 10 }));
}

/** The table's YAML file, or null. Accepts the name in any case, with or without its schema. */
export function readTableYaml(name) {
  const { dir, lowerNames } = catalog();
  const bare = String(name ?? '').trim().toLowerCase().split('.').pop();
  const table = lowerNames.get(bare);
  if (!table) return null;
  return { table, yaml: fs.readFileSync(path.join(dir, 'tables', `${table}.yaml`), 'utf8') };
}

/** Near spellings of a table name that does not exist, for the error a lookup returns. */
export function similarTableNames(name, limit = 5) {
  const { lowerNames } = catalog();
  const wanted = String(name ?? '').trim().toLowerCase().split('.').pop();
  return [...lowerNames.entries()]
    .map(([lower, table]) => ({ table, score: similarity(wanted, lower) + tokens(wanted).filter((word) => tokens(lower).includes(word)).length * 0.2 }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((candidate) => candidate.table);
}

export function domainsInIndex() {
  return [...new Set(catalog().entries.map(({ entry }) => entry.domain))].sort();
}

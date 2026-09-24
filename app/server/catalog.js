import fs from 'node:fs';
import { config } from './config.js';

const raw = JSON.parse(fs.readFileSync(config.catalogPath, 'utf8'));
export const tables = raw.tables;

// The SQL schema every draft is written against. Read from the catalog so that
// pointing CATALOG_PATH at a different warehouse does not also require a code
// change; the bundled fixture declares bank_dwh, which stays the fallback for a
// catalog that omits it.
export const schemaName = raw.schema_name || 'bank_dwh';

// Stamped onto every indexed document and required by every search. Defined
// once because a writer and a filter that disagree do not raise an error --
// they return an empty result set, which reads as "nothing matched".
export const DOCUMENT_STATUS = 'synthetic_fixture';
export const tableByName = new Map(tables.map((table) => [table.table_name, table]));
export const domains = [...new Set(tables.map((table) => table.domain))].sort();

export function tableDocument(table) {
  const physicalName = `${schemaName}.${table.table_name}`;
  const columnSummary = table.columns.map((column) => `${column.column_name} ${column.description}`).join(' ');
  return {
    document_id: `table.${schemaName}.${table.table_name}`,
    status: DOCUMENT_STATUS,
    domain_id: table.domain,
    document_type: 'table',
    table_name: table.table_name,
    title: `${table.table_name.replaceAll('_', ' ')} (${physicalName})`,
    grain: table.grain,
    table_type: table.table_type,
    column_names: table.columns.map((column) => column.column_name),
    search_text: `${table.domain.replaceAll('_', ' ')} ${table.table_name.replaceAll('_', ' ')} ${table.grain} ${columnSummary}`,
    columns: table.columns.map(({ column_name, data_type, nullable, description }) => ({ column_name, data_type, nullable, description })),
    relationships: table.relationships,
  };
}

export function contextForHits(question, hits, maxTables = 8) {
  const words = (value) => new Set((String(value).toLowerCase().match(/[a-z0-9]+/g) || [])
    .map((word) => word.endsWith('ies') && word.length > 4 ? `${word.slice(0, -3)}y` : word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word));
  const questionWords = words(question);
  const overlap = (table) => [...words(table.table_name.replace(/^(fact|dim)_/, ''))]
    .filter((word) => questionWords.has(word)).length;
  const dateIntent = /\b(date|daily|day|week|month|year|quarter|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d\d)\b/i.test(question);
  const ranked = hits.map((hit, index) => ({ table: tableByName.get(hit.table_name), index }))
    .filter(({ table }) => table)
    .sort((a, b) => overlap(b.table) - overlap(a.table) || a.index - b.index);
  const selected = new Map();
  const directLimit = Math.max(1, maxTables - 3);
  for (const { table } of ranked) {
    selected.set(table.table_name, table);
    if (selected.size >= directLimit) break;
  }
  const candidateDimensions = new Map();
  for (const table of [...selected.values()]) {
    if (table.table_type !== 'fact') continue;
    for (const relation of table.relationships) {
      const dim = tableByName.get(relation.to_table);
      if (!dim || selected.has(dim.table_name)) continue;
      const relevance = overlap(dim) * 10 + (dim.table_name === 'dim_date' && dateIntent ? 8 : 0);
      if (relevance > 0) candidateDimensions.set(dim.table_name, { table: dim, relevance: Math.max(relevance, candidateDimensions.get(dim.table_name)?.relevance || 0) });
    }
  }
  for (const { table } of [...candidateDimensions.values()].sort((a, b) => b.relevance - a.relevance)) {
    if (selected.size >= maxTables) break;
    selected.set(table.table_name, table);
  }
  if (selected.size < directLimit) {
    for (const { table } of ranked) {
      selected.set(table.table_name, table);
      if (selected.size >= directLimit) break;
    }
  }
  const selectedNames = new Set(selected.keys());
  const relationships = [...selected.values()].flatMap((table) => table.relationships)
    .filter((relation) => selectedNames.has(relation.to_table));
  return { tables: [...selected.values()], relationships };
}

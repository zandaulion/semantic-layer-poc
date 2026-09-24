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

// SQL identifiers are case-insensitive unless quoted, and a model writing
// against an uppercase catalog will happily lowercase them in its draft. Keying
// a second index by lower case keeps the safety check from rejecting a correct
// reference on spelling alone -- which is how every draft against a warehouse
// with uppercase physical names was being reported as touching unknown tables.
export const tableByLowerName = new Map(tables.map((table) => [table.table_name.toLowerCase(), table]));
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

// How many facts in the whole catalog join to each dimension.
//
// A name-free stand-in for "conformed dimension". In a star schema the date
// and party dimensions are referenced by nearly every fact while a
// special-purpose lookup is referenced by one or two, so degree orders
// candidates by how likely they are to be needed without reading a single
// table name. It is computed once, from the catalog, at load.
const dimensionDegree = (() => {
  const degree = new Map();
  for (const table of tables) {
    if (table.table_type !== 'fact') continue;
    for (const target of new Set((table.relationships ?? []).map((relation) => relation.to_table))) {
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  return degree;
})();

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

  // Fallback: when lexical scoring supplied no dimension at all, take the
  // declared neighbours instead.
  //
  // The ranking above scores a dimension by lexical overlap, which works while
  // tables are called dim_currency and questions ask about currency. Measured
  // against a catalog using bank-style abbreviations -- D_CCY, D_DT -- every
  // score fell to zero and no dimension was added at all, so drafts lost the
  // joins they needed even though search had found the facts correctly. The
  // names are readable.
  //
  // Deliberately a fallback rather than the default. Filling the spare slots
  // unconditionally also fills them for catalogs where the lexical path already
  // works, which measured as roughly 60% more context tables and a
  // correspondingly larger prompt for no gain in grounding -- and prompt size
  // is the constraint that binds first on an on-premise KV cache.
  const neighbours = candidateDimensions.size === 0 ? new Map() : null;
  if (neighbours) {
    for (const table of [...selected.values()]) {
      if (table.table_type !== 'fact') continue;
      for (const relation of table.relationships) {
        const dim = tableByName.get(relation.to_table);
        if (dim && !selected.has(dim.table_name)) neighbours.set(dim.table_name, dim);
      }
    }
    for (const dim of [...neighbours.values()]
      .sort((a, b) => (dimensionDegree.get(b.table_name) ?? 0) - (dimensionDegree.get(a.table_name) ?? 0))) {
      if (selected.size >= maxTables) break;
      selected.set(dim.table_name, dim);
    }
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

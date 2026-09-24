import fs from 'node:fs';
import { config } from './config.js';

const raw = JSON.parse(fs.readFileSync(config.catalogPath, 'utf8'));
export const tables = raw.tables;
export const tableByName = new Map(tables.map((table) => [table.table_name, table]));
export const domains = [...new Set(tables.map((table) => table.domain))].sort();

export function tableDocument(table) {
  const physicalName = `bank_dwh.${table.table_name}`;
  const columnSummary = table.columns.map((column) => `${column.column_name} ${column.description}`).join(' ');
  return {
    document_id: `table.bank_dwh.${table.table_name}`,
    status: 'synthetic_fixture',
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
  const selected = new Map();
  for (const hit of hits) {
    const table = tableByName.get(hit.table_name);
    if (table) selected.set(table.table_name, table);
    if (selected.size >= maxTables) break;
  }
  const questionWords = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const table of [...selected.values()]) {
    if (table.table_type !== 'fact') continue;
    for (const relation of table.relationships) {
      if (selected.size >= maxTables) break;
      const dim = tableByName.get(relation.to_table);
      if (dim && questionWords.includes(dim.table_name.slice(4).replaceAll('_', ' '))) {
        selected.set(dim.table_name, dim);
      }
    }
  }
  const selectedNames = new Set(selected.keys());
  const relationships = [...selected.values()].flatMap((table) => table.relationships)
    .filter((relation) => selectedNames.has(relation.to_table));
  return { tables: [...selected.values()], relationships };
}

/**
 * The agent's view of the warehouse: one YAML file per table and a table
 * index, written from the same catalog the pipeline indexes into
 * Elasticsearch.
 *
 * Generated, not hand-kept. Both answer modes therefore see one source, which
 * is what makes comparing them mean anything: a difference in their answers is
 * a difference in how they look, not in what there is to find. A cryptic
 * benchmark run points CATALOG_PATH at the abbreviated catalog and gets
 * abbreviated YAML with no further step.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { schemaName, tables } from './catalog.js';

// Plain scalars are kept where YAML reads them back unchanged; anything else
// is written as a JSON string, which is valid double-quoted YAML.
function scalar(value) {
  const text = String(value ?? '');
  if (text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|[:#]\s|:$|\s$|^(?:true|false|null|yes|no|~|[\d.+-]+)$/i.test(text)) return JSON.stringify(text);
  return text;
}

export function tableYaml(table) {
  const lines = [
    `table: ${schemaName}.${table.table_name}`,
    `type: ${table.table_type}`,
    `domain: ${table.domain}`,
    `grain: ${scalar(table.grain)}`,
    'columns:',
  ];
  for (const column of table.columns) {
    lines.push(`  - name: ${column.column_name}`);
    lines.push(`    type: ${scalar(column.data_type)}`);
    if (column.is_primary_key) lines.push('    primary_key: true');
    if (column.nullable === false) lines.push('    nullable: false');
    if (column.description) lines.push(`    description: ${scalar(column.description)}`);
  }
  const joins = table.relationships ?? [];
  if (joins.length) {
    lines.push('joins:');
    for (const relation of joins) lines.push(`  - ${relation.from_column} -> ${schemaName}.${relation.to_table}.${relation.to_column}`);
  }
  return `${lines.join('\n')}\n`;
}

export function indexEntry(table) {
  return {
    table: table.table_name,
    type: table.table_type,
    domain: table.domain,
    grain: table.grain,
    columns: table.columns.map((column) => column.column_name),
    // Short on purpose: the index is what search ranks; the YAML is what a
    // lookup reads. Column descriptions carry the business vocabulary that
    // abbreviated names do not (see retrieval-and-naming.md).
    descriptions: table.columns.map((column) => column.description).filter(Boolean).join(' '),
  };
}

/**
 * Writes the files and returns their directory. Keyed by a hash of the
 * catalog, so a changed catalog gets fresh files and an unchanged one is
 * written once. CATALOG_YAML_DIR names a directory to use instead, for a
 * deployment whose table files are maintained by another system.
 */
export function ensureCatalogFiles() {
  if (config.catalogYamlDir) return config.catalogYamlDir;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(config.catalogPath)).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `dwh-catalog-${digest}`);
  if (fs.existsSync(path.join(dir, 'table-index.json'))) return dir;
  writeCatalogFiles(dir);
  return dir;
}

export function writeCatalogFiles(dir) {
  const staging = `${dir}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'tables'), { recursive: true });
  for (const table of tables) fs.writeFileSync(path.join(staging, 'tables', `${table.table_name}.yaml`), tableYaml(table));
  fs.writeFileSync(path.join(staging, 'table-index.json'), JSON.stringify({ schema: schemaName, tables: tables.map(indexEntry) }));
  // Renamed into place whole, so a reader never sees half a catalog; a second
  // process that got there first wins, and its files are the same.
  try { fs.renameSync(staging, dir); }
  catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(path.join(dir, 'table-index.json'))) throw error;
  }
}

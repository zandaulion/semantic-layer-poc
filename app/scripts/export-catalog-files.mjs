/**
 * Writes the agent's catalog files -- one YAML per table and table-index.json
 * -- for reading. The server writes its own copy on demand; this is for a
 * person who wants to see what the agent sees.
 *
 *   node scripts/export-catalog-files.mjs [DIR]
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeCatalogFiles } from '../server/catalog-files.js';

const dir = path.resolve(process.argv[2] || 'catalog-files');
fs.rmSync(dir, { recursive: true, force: true });
writeCatalogFiles(dir);
console.log(`Wrote ${fs.readdirSync(path.join(dir, 'tables')).length} table files and table-index.json to ${dir}`);

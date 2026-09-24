/**
 * Checks a catalog and says what is wrong with it.
 *
 *   node server/validate-catalog.mjs [path]
 *
 * Defaults to CATALOG_PATH, so it validates whatever the application would
 * actually load. Exits non-zero on errors; warnings are printed and do not fail,
 * because a thin catalog is usable and a broken one is not.
 */

import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { validateCatalog } from './catalog-schema.js';

const file = process.argv[2] ?? config.catalogPath;

let catalog;
try {
  catalog = JSON.parse(await readFile(file, 'utf8'));
} catch (error) {
  console.error(`Could not read a JSON catalog from ${file}: ${error.message}`);
  process.exit(2);
}

const { errors, warnings, summary } = validateCatalog(catalog);

console.log(`\n  ${file}`);
console.log(`  schema ${summary.schema_name} · ${summary.tables} tables · ${summary.columns} columns `
  + `· ${summary.relationships} relationships`);
if (summary.domains?.length) console.log(`  domains: ${summary.domains.join(', ')}`);

for (const warning of warnings) console.log(`\n  warning: ${warning}`);
for (const error of errors) console.error(`\n  error: ${error}`);

console.log(errors.length
  ? `\n  ${errors.length} error${errors.length === 1 ? '' : 's'}; this catalog would not work correctly.\n`
  : `\n  Valid${warnings.length ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.\n`);

process.exit(errors.length ? 1 : 0);

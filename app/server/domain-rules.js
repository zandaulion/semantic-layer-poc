import fs from 'node:fs';
import { config } from './config.js';

/** The business rules in DOMAIN_RULES_PATH, or nothing if the file is absent or empty. */
export function domainRules() {
  try { return fs.readFileSync(config.domainRulesPath, 'utf8').trim(); }
  catch { return ''; }
}

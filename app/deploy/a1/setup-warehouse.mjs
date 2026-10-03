/**
 * Prepares the warehouse container (deploy/quadlet/banking-dwh-pg.container):
 * writes its init scripts -- the benchmark seed, a cryptic copy, and the
 * read-only role -- and creates its passwords on first run.
 *
 *   node app/deploy/a1/setup-warehouse.mjs
 *
 * Secrets go to two files, so that each container gets only what it needs:
 * warehouse-pg.env (superuser and role passwords) for the database, and
 * warehouse-app.env (one read-only URL) for the application. Existing
 * passwords are kept; rerun it after the seed or the catalog changes.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crypticRenameSql } from '../../eval/cryptic-names.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', '..');
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'banking-sql-poc');
const initDir = path.join(os.homedir(), '.local', 'share', 'banking-dwh-pg', 'initdb');

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

const pgEnvFile = path.join(configDir, 'warehouse-pg.env');
const appEnvFile = path.join(configDir, 'warehouse-app.env');
const existing = readEnv(pgEnvFile);
const secret = () => crypto.randomBytes(24).toString('base64url');
const superPassword = existing.POSTGRES_PASSWORD || secret();
const readerPassword = existing.DWH_RO_PASSWORD || secret();
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(pgEnvFile, `POSTGRES_PASSWORD=${superPassword}\nDWH_RO_PASSWORD=${readerPassword}\n`, { mode: 0o600 });
fs.writeFileSync(appEnvFile, `DWH_URL=postgres://dwh_ro:${readerPassword}@banking-dwh-pg:5432/dwh\n`, { mode: 0o600 });

fs.mkdirSync(initDir, { recursive: true });
for (const name of fs.readdirSync(initDir)) fs.rmSync(path.join(initDir, name));
execFileSync('node', [path.join(appDir, 'eval', 'bench', 'seed.mjs'), '--out', path.join(initDir, '10-seed.sql')], { stdio: 'inherit' });
const catalog = JSON.parse(fs.readFileSync(path.join(appDir, '..', 'banking-poc', 'catalog.json'), 'utf8'));
// Not .sql: the entrypoint would run it against the wrong database.
fs.writeFileSync(path.join(initDir, 'cryptic-rename.sql.in'), crypticRenameSql(catalog));
fs.writeFileSync(path.join(initDir, '20-cryptic.sh'), `#!/bin/sh
# The same data under the abbreviated names of eval/cryptic-names.mjs.
set -e
createdb -U "$POSTGRES_USER" dwh_cryptic
cat /docker-entrypoint-initdb.d/10-seed.sql /docker-entrypoint-initdb.d/cryptic-rename.sql.in \\
  | psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d dwh_cryptic
`);
fs.writeFileSync(path.join(initDir, '30-reader.sh'), `#!/bin/sh
# The only user the application has: it can read the warehouse schema and
# nothing else, every transaction it opens is read-only, and no statement may
# run longer than fifteen seconds.
set -e
psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d dwh -v pw="$DWH_RO_PASSWORD" <<'SQL'
CREATE ROLE dwh_ro LOGIN PASSWORD :'pw' CONNECTION LIMIT 16;
ALTER ROLE dwh_ro SET default_transaction_read_only = on;
ALTER ROLE dwh_ro SET statement_timeout = '15s';
ALTER ROLE dwh_ro SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE dwh_ro SET search_path = bank_dwh;
ALTER ROLE dwh_ro SET work_mem = '16MB';
SQL
for db in dwh dwh_cryptic; do
  psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" <<SQL
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO dwh_ro;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA bank_dwh TO dwh_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA bank_dwh TO dwh_ro;
SQL
done
`);
for (const name of ['20-cryptic.sh', '30-reader.sh']) fs.chmodSync(path.join(initDir, name), 0o755);
console.log(`Wrote ${initDir}, ${pgEnvFile} and ${appEnvFile}.`);

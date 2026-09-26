/**
 * The benchmark's PostgreSQL: a throwaway container holding the seeded copy of
 * the warehouse, and a way to run a query in it as a read-only user.
 *
 * It publishes no port. Queries go in through `podman exec`, so nothing on the
 * network can reach the database, and it keeps its data on a tmpfs, so
 * stopping the container leaves nothing behind.
 */

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const CONTAINER = 'banking-eval-pg';
const IMAGE = 'docker.io/library/postgres:17-alpine';
const DATABASE = 'dwh';

async function podman(args, options = {}) {
  return run('podman', args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

function psql(args, input) {
  return new Promise((resolve) => {
    const child = spawn('podman', ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function running() {
  try {
    const { stdout } = await podman(['inspect', '--format', '{{.State.Running}}', CONTAINER]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Starts the database if it is not running and loads the seed if the loaded
 * one is missing or older. Returns the seed version in use.
 */
export async function ensureDatabase(seedFile) {
  const seed = await readFile(seedFile, 'utf8');
  const version = seed.slice(0, 200).match(/^-- seed ([0-9a-f]+)/)?.[1];
  if (!version) throw new Error(`${seedFile} is not a benchmark seed`);
  if (!(await running())) {
    await podman(['rm', '--force', '--ignore', CONTAINER]);
    await podman(['run', '--detach', '--rm', '--name', CONTAINER, '--memory', '768m',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=1g', '--network', 'none',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', `POSTGRES_DB=${DATABASE}`, IMAGE]);
    // The entrypoint restarts the server once after initialising, so wait for
    // a query to succeed rather than for the port.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const probe = await psql(['-U', 'postgres', '-d', DATABASE, '-c', 'SELECT 1'], '');
      if (probe.code === 0) break;
      if (Date.now() > deadline) throw new Error(`PostgreSQL did not start: ${probe.stderr.trim()}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const loaded = await psql(['-U', 'postgres', '-d', DATABASE, '-At', '-c', "SELECT obj_description('bank_dwh'::regnamespace)"], '');
  if (loaded.code === 0 && loaded.stdout.trim() === version) return version;

  const load = await psql(['-U', 'postgres', '-d', DATABASE], seed);
  if (load.code !== 0) throw new Error(`Loading the seed failed: ${load.stderr.slice(0, 500)}`);
  // Drafts run as a user that can read the warehouse and nothing else, in a
  // read-only transaction with a time limit. A draft that tries to write fails
  // here even if every check before it missed the statement.
  const grants = await psql(['-U', 'postgres', '-d', DATABASE], `
    DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bench_ro') THEN CREATE ROLE bench_ro LOGIN; END IF; END $$;
    GRANT USAGE ON SCHEMA bank_dwh TO bench_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA bank_dwh TO bench_ro;
    ALTER ROLE bench_ro SET default_transaction_read_only = on;
    ALTER ROLE bench_ro SET statement_timeout = '15s';
    ALTER ROLE bench_ro SET search_path = bank_dwh;
    COMMENT ON SCHEMA bank_dwh IS '${version}';
  `);
  if (grants.code !== 0) throw new Error(`Setting up the read-only user failed: ${grants.stderr}`);
  return version;
}

export async function stopDatabase() {
  await podman(['rm', '--force', '--ignore', CONTAINER]).catch(() => {});
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; any = true; } else if (ch === ',') { row.push(any || field ? field : null); field = ''; any = false; } else if (ch === '\n') {
      row.push(any || field ? field : null); rows.push(row); row = []; field = ''; any = false;
    } else if (ch !== '\r') field += ch;
  }
  if (field || any || row.length) { row.push(any || field ? field : null); rows.push(row); }
  return rows;
}

/**
 * Runs one query as the read-only user. Resolves `{ ok, columns, rows }` or
 * `{ ok: false, error }`; never throws for a bad query, because a draft that
 * does not run is a result, not a harness failure.
 */
export async function query(sql) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!text) return { ok: false, error: 'empty statement' };
  const result = await psql(['-U', 'bench_ro', '-d', DATABASE, '--csv'], `${text};\n`);
  if (result.code !== 0) return { ok: false, error: result.stderr.replace(/^psql:[^:]*:\d+: /gm, '').trim().slice(0, 300) };
  const [columns = [], ...rows] = parseCsv(result.stdout);
  return { ok: true, columns, rows };
}

/**
 * Checks each recorded example by running it.
 *
 * Every example is one of the model benchmark's hard questions, which have a
 * single right answer. This runs the recorded draft and the benchmark's
 * reference query against the benchmark's seeded PostgreSQL copy of the
 * warehouse, compares the results the way the benchmark does, and writes the
 * verdict into examples.json. capture-screenshots.mjs refuses an example that
 * is not verified correct; generate-examples.mjs drafts a wrong one again.
 *
 * Runs on the host that runs the POC (it needs podman):
 *
 *   node portfolio/verify-examples.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const bench = path.join(root, '..', 'app', 'eval', 'bench');
const { ensureDatabase, query, stopDatabase } = await import(path.join(bench, 'pg.mjs'));
const { matches } = await import(path.join(bench, 'score.mjs'));

const file = path.join(root, 'examples.json');
const examples = JSON.parse(await fs.readFile(file, 'utf8'));
const { cases } = JSON.parse(await fs.readFile(path.join(bench, 'cases.json'), 'utf8'));

const seed = path.join(bench, '.cache', 'seed.sql');
await fs.mkdir(path.dirname(seed), { recursive: true });
await promisify(execFile)('node', [path.join(bench, 'seed.mjs'), '--out', seed]);
await ensureDatabase(seed);

let wrong = 0;
try {
  for (const example of examples) {
    const testCase = cases.find((c) => c.id === example.case_id);
    if (!testCase?.reference) throw new Error(`${example.slug}: no benchmark case ${example.case_id}`);
    const reference = await query(testCase.reference);
    const draft = await query(example.result.sql);
    const correct = draft.ok && matches(reference, draft, { ordered: testCase.ordered, tolerance: testCase.tolerance ?? 0.01 });
    example.verified = {
      correct,
      checked_at: new Date().toISOString(),
      rows: draft.ok ? draft.rows.length : null,
      ...(draft.ok ? {} : { error: draft.error }),
    };
    if (!correct) wrong += 1;
    console.log(`${correct ? 'correct' : 'WRONG  '} ${example.slug}${draft.ok ? '' : `: ${draft.error.split('\n')[0]}`}`);
  }
} finally {
  await stopDatabase();
}
await fs.writeFile(file, `${JSON.stringify(examples, null, 2)}\n`);
console.log(wrong ? `${wrong} wrong: run generate-examples.mjs again to redraft them, then verify again.` : 'All examples verified correct.');
process.exitCode = wrong ? 1 : 0;

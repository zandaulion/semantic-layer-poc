import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = process.env.POC_APP_DIR || path.resolve('app');
const outputPath = process.env.POC_OUTPUT || path.resolve('portfolio/examples.json');
const { searchTables } = await import(pathToFileURL(path.join(appDir, 'server/elastic.js')));
const { generateDraft } = await import(pathToFileURL(path.join(appDir, 'server/model.js')));

// Ten of the model benchmark's hard questions: each has one right answer, and
// the recorded draft is checked against it by verify-examples.mjs before any
// screenshot is taken. Their wording is read from the benchmark, so the two
// cannot drift apart. All retrieval runs across every domain, as in the
// benchmark.
const PICKS = [
  ['top5-wire-customers', 't1-top5-wire-customers-2025'],
  ['wire-and-atm-customers', 't1-wire-and-atm-customers-2025'],
  ['loans-90-days-past-due', 't1-loans-90dpd-2025-08-31'],
  ['top-merchant-categories', 't1-top3-merchant-categories-2025'],
  ['declined-card-share', 't1-declined-card-share-2025'],
  ['escalated-complaints', 't1-escalated-complaints-by-category-2025'],
  ['high-aml-alerts', 't1-high-aml-by-jurisdiction-2025'],
  ['mobile-transactions', 't1-mobile-transactions-per-year'],
  ['closing-balance', 't1-avg-closing-balance-2025-06-30'],
  ['sme-cross-border', 't1-sme-cross-border-2025'],
];
const { cases } = JSON.parse(await fs.readFile(path.join(appDir, 'eval/bench/cases.json'), 'utf8'));
const examples = PICKS.map(([slug, caseId]) => ({ slug, case_id: caseId, question: cases.find((c) => c.id === caseId).question, domain: 'all' }));

const completed = JSON.parse(await fs.readFile(outputPath, 'utf8').catch(() => '[]'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [index, example] of examples.entries()) {
  // Kept unless verify-examples.mjs found its result wrong; delete an entry
  // to have it drafted again.
  if (completed.some((item) => item.slug === example.slug && item.question === example.question && item.result.status === 'draft'
      && item.verified?.correct !== false)) continue;
  let result;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const hits = await searchTables(example.question, example.domain);
      result = await generateDraft({ question: example.question, hits });
      break;
    } catch (error) {
      if (attempt === 4 || !/429|rate limit|json_validate_failed/i.test(error.message)) throw error;
      await pause(/429|rate limit/i.test(error.message) ? 35_000 : 15_000);
    }
  }
  const oldIndex = completed.findIndex((item) => item.slug === example.slug);
  if (oldIndex >= 0) completed[oldIndex] = { ...example, result };
  else completed.push({ ...example, result });
  completed.sort((a, b) => examples.findIndex((item) => item.slug === a.slug) - examples.findIndex((item) => item.slug === b.slug));
  await fs.writeFile(outputPath, JSON.stringify(completed, null, 2));
  process.stdout.write(`${index + 1}/${examples.length} ${example.slug}: ${result.status}, ${result.sql?.length || 0} SQL characters\n`);
  if (index >= 2 && index < examples.length - 1) await pause(30_000);
}

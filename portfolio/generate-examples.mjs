import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = process.env.POC_APP_DIR || path.resolve('app');
const outputPath = process.env.POC_OUTPUT || path.resolve('portfolio/examples.json');
const { searchTables } = await import(pathToFileURL(path.join(appDir, 'server/elastic.js')));
const { generateDraft } = await import(pathToFileURL(path.join(appDir, 'server/model.js')));

const examples = [
  { slug: 'active-customers', question: 'Number of active customers last month', domain: 'conformed' },
  { slug: 'default-clients', question: 'Clients in default at end of August 2026', domain: 'all' },
  { slug: 'loan-repayments', question: 'Show total actual loan repayments by customer for January 2026', domain: 'lending' },
  { slug: 'card-authorizations', question: 'Count card authorizations by merchant in August 2026', domain: 'payments' },
  { slug: 'deposit-balances', question: 'Show total closing deposit balance by branch on August 31, 2026', domain: 'deposits' },
  { slug: 'fraud-alerts', question: 'Count fraud alerts by alert_severity_code', domain: 'risk_compliance' },
  { slug: 'credit-risk', question: 'Using fact_credit_risk_exposure_daily, show average probability_of_default_rate by branch on August 31, 2026', domain: 'risk_compliance' },
  { slug: 'payment-volume', question: 'Using fact_payment_transaction, show total amount by currency using currency_key and dim_currency.currency_code', domain: 'payments' },
  { slug: 'account-balances', question: 'Using fact_account_balance_daily, show daily total closing_balance_amount by currency from August 1 through 7, 2026', domain: 'deposits' },
  { slug: 'aml-alerts', question: 'Count AML alerts by investigation_status_code', domain: 'risk_compliance' },
];

const completed = JSON.parse(await fs.readFile(outputPath, 'utf8').catch(() => '[]'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [index, example] of examples.entries()) {
  if (completed.some((item) => item.slug === example.slug && item.question === example.question && item.result.status === 'draft'
      && !/\b(?:detection_at|settled_at)\b/i.test(item.result.sql))) continue;
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

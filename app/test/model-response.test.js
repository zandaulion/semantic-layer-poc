import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../server/config.js';
import { generateDraft } from '../server/model.js';

const hits = ['fact_wire_transfer', 'dim_currency', 'dim_date'].map((table_name) => ({ table_name }));

function withReply(choice, run) {
  const realFetch = globalThis.fetch;
  const realKey = config.modelApiKey;
  config.modelApiKey = 'test';
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
  return run().finally(() => { globalThis.fetch = realFetch; config.modelApiKey = realKey; });
}

test('a reply cut off at the token limit is reported as truncated, not as a schema violation', async () => {
  const content = '{"status":"draft","sql":"SELECT 1","interpretation":"x","assumptions":[],"clarification_question":""' + ' \n'.repeat(500);
  await withReply({ finish_reason: 'length', message: { content } }, async () => {
    await assert.rejects(
      generateDraft({ question: 'Total wire transfer volume by currency in 2025', hits }),
      (error) => error.publicCode === 'model_truncated' && !(error instanceof SyntaxError),
    );
  });
});

test('a complete reply still parses', async () => {
  const content = JSON.stringify({
    status: 'draft', sql: 'SELECT 1 FROM bank_dwh.fact_wire_transfer', interpretation: 'x', assumptions: [],
    clarification_question: null, sources: ['table.bank_dwh.fact_wire_transfer'],
  });
  await withReply({ finish_reason: 'stop', message: { content } }, async () => {
    const draft = await generateDraft({ question: 'Total wire transfer volume by currency in 2025', hits });
    assert.equal(draft.status, 'draft');
  });
});

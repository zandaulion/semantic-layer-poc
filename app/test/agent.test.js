import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../server/agent.js';
import { tableYaml } from '../server/catalog-files.js';
import { readTableYaml, searchCatalog, similarTableNames } from '../server/catalog-tools.js';
import { tableByName } from '../server/catalog.js';
import { config } from '../server/config.js';
import { checksAfterExecution } from '../server/warehouse.js';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** Replays scripted assistant messages, one per model call, and records what each request carried. */
function withScript(messages, run) {
  const realFetch = globalThis.fetch;
  const realKey = config.modelApiKey;
  const requests = [];
  config.modelApiKey = 'test';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const message = messages[Math.min(requests.length - 1, messages.length - 1)];
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { status: 200 });
  };
  return run(requests).finally(() => { globalThis.fetch = realFetch; config.modelApiKey = realKey; });
}

const answer = {
  status: 'draft',
  sql: 'SELECT COUNT(*) FROM bank_dwh.fact_wire_transfer',
  interpretation: 'Counts wire transfers.',
  assumptions: [],
  clarification_question: null,
  sources: ['table.bank_dwh.fact_wire_transfer'],
};

test('search finds a fact by business words, and by the abbreviation of one', () => {
  assert.equal(searchCatalog('wire transfers')[0].table, 'fact_wire_transfer');
  assert.ok(searchCatalog('acct balance').some((hit) => hit.table === 'fact_account_balance_daily'));
});

test('a domain the model guesses ranks tables but does not hide the ones filed elsewhere', () => {
  // The fixture files card authorizations under payments, not cards.
  assert.equal(searchCatalog('card authorization', { preferDomain: 'cards', type: 'fact' })[0].table, 'fact_card_authorization');
  assert.ok(!searchCatalog('card authorization', { domain: 'cards' }).some((hit) => hit.table === 'fact_card_authorization'));
});

test('a table can be read in any case and with its schema; a wrong name suggests near ones', () => {
  assert.equal(readTableYaml('BANK_DWH.FACT_WIRE_TRANSFER').table, 'fact_wire_transfer');
  assert.equal(readTableYaml('fact_wire_transfers'), null);
  assert.ok(similarTableNames('fact_wire_transfers').includes('fact_wire_transfer'));
});

test('YAML quotes what a plain scalar would misread', () => {
  const yaml = tableYaml({ ...tableByName.get('dim_date'), grain: 'Key: value # not a comment' });
  assert.match(yaml, /^grain: "Key: value # not a comment"$/m);
});

test('the agent looks a table up, then finishes through submit_answer', async () => {
  await withScript([
    { content: '', tool_calls: [call('a', 'search_tables', { query: 'wire transfer' })] },
    { content: '', tool_calls: [call('b', 'describe_table', { table: 'fact_wire_transfer' })] },
    { content: '', tool_calls: [call('c', 'submit_answer', answer)] },
  ], async (requests) => {
    const events = [];
    const result = await runAgent({ question: 'How many wire transfers are there?', onEvent: (event) => events.push(event.type) });
    assert.equal(result.status, 'draft');
    assert.deepEqual(result.sources, ['table.bank_dwh.fact_wire_transfer']);
    assert.deepEqual(result.retrieved_tables.map((table) => table.table_name), ['fact_wire_transfer']);
    assert.equal(result.usage.model_calls, 3);
    assert.equal(requests.length, 3);
    // The table definition went back to the model as a tool message.
    assert.match(requests[2].messages.at(-1).content, /^table: bank_dwh\.fact_wire_transfer$/m);
    assert.ok(events.includes('tool_result'));
  });
});

test('a table the SQL uses without having read it is named in the findings', async () => {
  await withScript([
    { content: '', tool_calls: [call('a', 'describe_table', { table: 'fact_wire_transfer' })] },
    { content: '', tool_calls: [call('b', 'submit_answer', { ...answer, sql: 'SELECT d.calendar_date FROM bank_dwh.fact_wire_transfer f JOIN bank_dwh.dim_date d ON d.date_key = f.business_date_key' })] },
  ], async () => {
    const result = await runAgent({ question: 'Wire transfer dates' });
    assert.ok(result.checks.findings.some((finding) => /without reading.*dim_date/.test(finding)));
  });
});

test('a write the model drafts anyway is never presented as a draft', async () => {
  await withScript([
    { content: '', tool_calls: [call('a', 'submit_answer', { ...answer, sql: 'DELETE FROM bank_dwh.fact_wire_transfer' })] },
  ], async () => {
    const result = await runAgent({ question: 'Delete all wire transfers' });
    assert.equal(result.status, 'needs_revision');
    assert.equal(result.checks.statement, 'failed');
  });
});

test('run_sql refuses a write before it reaches the warehouse', async () => {
  let reached = false;
  await withScript([
    { content: '', tool_calls: [call('a', 'run_sql', { sql: 'DROP TABLE bank_dwh.dim_date' })] },
    { content: '', tool_calls: [call('b', 'submit_answer', { ...answer, status: 'unsupported', sql: '' })] },
  ], async (requests) => {
    const result = await runAgent({ question: 'Drop the date table', runSql: async () => { reached = true; return { ok: true }; } });
    assert.equal(reached, false);
    assert.match(requests[1].messages.at(-1).content, /read-only/);
    assert.equal(result.status, 'unsupported');
  });
});

test('out of steps, the agent is made to answer from what it has read', async () => {
  const realSteps = config.agentMaxSteps;
  config.agentMaxSteps = 2;
  try {
    await withScript([
      { content: '', tool_calls: [call('a', 'search_tables', { query: 'wire' })] },
      { content: '', tool_calls: [call('b', 'search_tables', { query: 'transfer' })] },
      { content: '', tool_calls: [call('c', 'submit_answer', answer)] },
    ], async (requests) => {
      const result = await runAgent({ question: 'How many wire transfers are there?' });
      assert.equal(result.status, 'draft');
      assert.deepEqual(requests.at(-1).tool_choice, { type: 'function', function: { name: 'submit_answer' } });
    });
  } finally { config.agentMaxSteps = realSteps; }
});

test('an answer with an invalid status is sent back, not accepted', async () => {
  await withScript([
    { content: '', tool_calls: [call('a', 'submit_answer', { ...answer, status: 'done' })] },
    { content: '', tool_calls: [call('b', 'submit_answer', answer)] },
  ], async (requests) => {
    const result = await runAgent({ question: 'How many wire transfers are there?' });
    assert.equal(result.status, 'draft');
    assert.match(requests[1].messages.at(-1).content, /status must be one of/);
  });
});

test('a run that worked verifies syntax and columns; one that failed verifies nothing', () => {
  const base = { statement: 'passed', tables: 'passed', syntax: 'not_verified', columns: 'not_verified', business: 'not_verified', execution: 'not_run', findings: [] };
  assert.deepEqual(checksAfterExecution(base, { ok: true }), { ...base, syntax: 'passed', columns: 'passed', execution: 'passed' });
  const failed = checksAfterExecution(base, { ok: false, error: 'column "year" does not exist' });
  assert.equal(failed.execution, 'failed');
  assert.equal(failed.syntax, 'not_verified');
  assert.match(failed.findings.at(-1), /year/);
});

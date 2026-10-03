/**
 * The agent answer mode: the model is given lookup tools and decides what to
 * read, instead of being handed a context that retrieval assembled for it --
 * the tool-calling shape many text-to-SQL assistants take.
 *
 * It ends by calling submit_answer with the same fields the pipeline's JSON
 * schema requires, so both modes produce one response shape: the review screen,
 * the safety check and the benchmark's scoring treat them alike.
 */

import { config } from './config.js';
import { DOCUMENT_STATUS, schemaName, tableByLowerName } from './catalog.js';
import { domainsInIndex, readTableYaml, searchCatalog, similarTableNames } from './catalog-tools.js';
import { chatCompletion } from './model-client.js';
import { domainRules } from './domain-rules.js';
import { responseSchema } from './model.js';
import { checkSql, referencedTables } from './sql-check.js';

const STATUSES = ['draft', 'needs_clarification', 'unsupported'];

export function agentTools({ canRunSql }) {
  const domains = domainsInIndex();
  const tools = [
    {
      type: 'function',
      function: {
        name: 'search_tables',
        description: 'Fuzzy search over the table index: table names, grains, column names and column descriptions. Returns the best matching tables with their grain. Search with business words; try other words if the first search misses.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Business words to look for, e.g. "loan balance outstanding principal".' },
            domain: { type: 'string', enum: domains, description: 'Optional subject area to rank first. Tables in other areas are still returned.' },
            type: { type: 'string', enum: ['fact', 'dimension'], description: 'Optional: only facts or only dimensions.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'describe_table',
        description: 'Reads one table definition: grain, every column with type and description, and the joins it declares. Read a table before using it in SQL.',
        parameters: {
          type: 'object',
          properties: { table: { type: 'string', description: 'Table name, with or without the schema.' } },
          required: ['table'],
        },
      },
    },
  ];
  if (canRunSql) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_sql',
        description: config.agentSqlCheck === 'explain'
          ? 'Checks one read-only SELECT against the warehouse without running it (EXPLAIN). Returns the database error, or the output columns if the query is valid. No rows are ever shown.'
          : 'Runs one read-only SELECT against the warehouse and returns the column names and up to 20 rows. Use it to check that a draft runs and that its result looks plausible, or to inspect the values a column holds.',
        parameters: {
          type: 'object',
          properties: { sql: { type: 'string', description: 'One PostgreSQL SELECT or WITH query.' } },
          required: ['sql'],
        },
      },
    });
  }
  tools.push({
    type: 'function',
    function: {
      name: 'submit_answer',
      description: 'Finishes the task. Call it exactly once, with the final SQL draft, a clarifying question, or the reason the request cannot be answered.',
      parameters: {
        ...responseSchema,
        properties: {
          ...responseSchema.properties,
          status: { ...responseSchema.properties.status, description: 'draft: SQL that answers the question. needs_clarification: one question the user must answer first. unsupported: the warehouse does not hold the data, or the request is not a read-only query.' },
          sources: { ...responseSchema.properties.sources, description: `Tables the SQL reads, as table.${schemaName}.<table_name>.` },
        },
      },
    },
  });
  return tools;
}

export function systemPrompt({ domain, canRunSql }) {
  return [
    `You are a SQL agent for a PostgreSQL data warehouse. Every table is in the schema ${schemaName}. You turn a business question into one read-only SQL draft that a person will review.`,
    'Work with the tools. Use search_tables to find candidate tables, then describe_table to read each table you intend to use. Never use a table or column you have not read with describe_table. Follow the joins the definitions declare.',
    canRunSql
      ? config.agentSqlCheck === 'explain'
        ? 'Before you submit a draft, check it with run_sql. If it reports an error, fix it. It shows no data, so you cannot inspect values.'
        : 'Before you submit a draft, run it with run_sql. If it fails, fix it. If it returns no rows or an implausible result, check your filters and joins.'
      : '',
    'Finish by calling submit_answer exactly once. Use status draft with the SQL, an interpretation and your assumptions. Use needs_clarification with one question under 160 characters, only when essential business meaning is missing after reading the definitions. Use unsupported, with sql empty, when the warehouse does not hold the data, or when the request asks to change data.',
    'Never write data. The draft must be a single SELECT or WITH query, fully qualified with the schema name.',
    domain && domain !== 'all' ? `The user limited the question to the subject area "${domain}".` : '',
    domainRules(),
  ].filter(Boolean).join('\n\n');
}

function summarise(name, result) {
  if (name === 'search_tables') return `${result.length} tables: ${result.slice(0, 5).map((r) => r.table).join(', ')}${result.length > 5 ? ', …' : ''}`;
  if (name === 'describe_table') return result.error ? result.error : `${result.table}`;
  if (name === 'run_sql') return !result.ok ? `error: ${result.error}` : result.explain_only ? `valid, ${result.columns.length} column${result.columns.length === 1 ? '' : 's'}` : `${result.row_count} row${result.row_count === 1 ? '' : 's'}`;
  return '';
}

/**
 * Runs one question through the agent. `onEvent` receives each step as it
 * happens, for streaming; the returned object is the same shape the
 * pipeline's generateDraft returns, plus the trace of what the agent did.
 */
export async function runAgent({ question, domain = 'all', history = [], previousSql = '', runSql = null, onEvent = () => {} }) {
  if (!config.modelApiKey) {
    return { status: 'error', code: 'model_unconfigured', message: 'The hosted model API key has not been configured on the server.' };
  }
  const canRunSql = typeof runSql === 'function';
  const tools = agentTools({ canRunSql });
  const messages = [{ role: 'system', content: systemPrompt({ domain, canRunSql }) }];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: turn.summary });
  }
  messages.push({ role: 'user', content: previousSql.trim() ? `${question}\n\nRevise this earlier draft:\n${previousSql}` : question });

  const described = new Map();
  const trace = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, model_calls: 0 };
  const deadline = Date.now() + config.agentTimeoutMs;
  let answer = null;
  let nudged = false;

  const call = async (toolChoice) => {
    for (;;) {
      try { return await callOnce(toolChoice); }
      catch (error) {
        // An agent sends the whole conversation again at every step, so it
        // meets a tokens-per-minute limit that one pipeline call never does.
        // Wait as the provider says, if that still fits the deadline.
        const hint = String(error.message).match(/429[\s\S]*try again in (?:(\d+)m)?([\d.]+)(ms|s)/i);
        const wait = hint ? (Number(hint[1] ?? 0) * 60 + Number(hint[2]) / (hint[3] === 'ms' ? 1000 : 1)) * 1000 + 500 : null;
        if (!wait || /per day|\bTPD\b|\bRPD\b/.test(error.message) || Date.now() + wait + 5_000 > deadline) throw error;
        onEvent({ type: 'waiting', reason: 'rate_limit', ms: Math.round(wait) });
        usage.rate_limit_waits = (usage.rate_limit_waits ?? 0) + 1;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  const callOnce = async (toolChoice) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(config.modelTimeoutMs, deadline - Date.now())));
    try {
      const payload = await chatCompletion({
        model: config.modelName,
        temperature: 0.1,
        max_completion_tokens: 2000,
        reasoning_effort: 'low',
        messages,
        tools,
        tool_choice: toolChoice,
      }, { signal: controller.signal });
      usage.model_calls += 1;
      for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) usage[field] += payload.usage?.[field] ?? 0;
      return payload.choices?.[0]?.message ?? {};
    } finally {
      clearTimeout(timer);
    }
  };

  const execute = async (name, args) => {
    if (name === 'search_tables') {
      return searchCatalog(String(args.query ?? ''), { domain: domain !== 'all' ? domain : undefined, preferDomain: args.domain, type: args.type, limit: 10 });
    }
    if (name === 'describe_table') {
      const found = readTableYaml(args.table);
      if (!found) return { error: `No table called ${args.table}. Similar names: ${similarTableNames(args.table).join(', ') || 'none'}.` };
      described.set(found.table, true);
      return found;
    }
    if (name === 'run_sql' && canRunSql) {
      const checks = checkSql(String(args.sql ?? ''));
      if (checks.statement === 'failed') return { ok: false, error: checks.findings.join(' ') };
      return runSql(String(args.sql), { maxRows: 20, explainOnly: config.agentSqlCheck === 'explain' });
    }
    return { error: `Unknown tool ${name}.` };
  };

  for (let step = 0; step < config.agentMaxSteps && !answer; step++) {
    if (Date.now() >= deadline) break;
    // Past this size the next request risks the server's context window;
    // stop looking and answer from what has been read.
    const size = messages.reduce((sum, message) => sum + String(message.content ?? '').length + JSON.stringify(message.tool_calls ?? '').length, 0);
    if (size > config.agentContextChars) break;
    onEvent({ type: 'step', step: step + 1 });
    const message = await call(config.agentToolChoice);
    const toolCalls = message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: message.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) {
      // A model that answers in prose has not finished; ask once for the
      // tool call, then stop asking and force it below.
      if (nudged) break;
      nudged = true;
      messages.push({ role: 'user', content: 'Call submit_answer to finish.' });
      continue;
    }
    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      let args;
      try { args = JSON.parse(toolCall.function?.arguments || '{}'); }
      catch { args = null; }
      if (name === 'submit_answer' && args && STATUSES.includes(args.status)) {
        answer = args;
        onEvent({ type: 'tool_call', name, arguments: { status: args.status } });
        break;
      }
      const started = Date.now();
      let result;
      if (!args) result = { error: 'The arguments were not valid JSON.' };
      else if (name === 'submit_answer') result = { error: `status must be one of ${STATUSES.join(', ')}.` };
      else {
        onEvent({ type: 'tool_call', name, arguments: args });
        try { result = await execute(name, args); }
        catch (error) { result = { error: String(error.message || error).slice(0, 300) }; }
      }
      const summary = summarise(name, result);
      trace.push({ tool: name, arguments: args, summary, ms: Date.now() - started });
      onEvent({ type: 'tool_result', name, summary, ...(name === 'run_sql' && result.ok ? { columns: result.columns, rows: result.rows } : {}) });
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: typeof result === 'string' ? result : name === 'describe_table' && result.yaml ? result.yaml : JSON.stringify(result) });
    }
  }

  if (!answer && Date.now() < deadline) {
    // Out of steps, room or patience: one last request that may only finish.
    onEvent({ type: 'step', step: 'final' });
    messages.push({ role: 'user', content: 'Stop looking up tables. Call submit_answer now with your best answer from what you have read.' });
    const message = await call({ type: 'function', function: { name: 'submit_answer' } });
    const toolCall = (message.tool_calls ?? []).find((entry) => entry.function?.name === 'submit_answer');
    try {
      const args = JSON.parse(toolCall?.function?.arguments || 'null');
      if (args && STATUSES.includes(args.status)) answer = args;
    } catch { /* reported below */ }
    if (answer) trace.push({ tool: 'submit_answer', arguments: { status: answer.status }, summary: 'forced', ms: 0 });
  }

  const retrievedTables = [...described.keys()].map((name) => {
    const table = tableByLowerName.get(name.toLowerCase());
    return {
      document_id: `table.${schemaName}.${table.table_name}`,
      table_name: table.table_name,
      title: table.table_name.replaceAll('_', ' '),
      grain: table.grain,
      domain_id: table.domain,
      table_type: table.table_type,
    };
  });

  if (!answer) {
    const error = new Error('The agent did not submit an answer');
    error.publicCode = 'agent_no_answer';
    error.publicMessage = 'The agent ran out of steps before it answered. Try a narrower question.';
    error.detail = { steps: trace.length, model_calls: usage.model_calls };
    throw error;
  }

  const sql = String(answer.sql ?? '');
  const allowedSources = new Set(retrievedTables.map((table) => table.document_id.toLowerCase()));
  const sources = (Array.isArray(answer.sources) ? answer.sources : [])
    .map((id) => {
      const bare = String(id).toLowerCase().replace(/^table\./, '').split('.').pop();
      const table = tableByLowerName.get(bare);
      return table ? `table.${schemaName}.${table.table_name}` : null;
    })
    .filter((id) => id && allowedSources.has(id.toLowerCase()));
  const checks = checkSql(sql);
  // The prompt forbids it; this says when it happened anyway, which is where
  // an invented column usually comes from.
  const unread = referencedTables(sql).known.filter((name) => !described.has(name));
  if (unread.length) checks.findings.push(`Used without reading its definition: ${unread.join(', ')}.`);
  const status = answer.status === 'draft' && (checks.statement === 'failed' || checks.tables !== 'passed') ? 'needs_revision' : answer.status;
  return {
    status,
    sql,
    interpretation: String(answer.interpretation ?? ''),
    assumptions: Array.isArray(answer.assumptions) ? answer.assumptions.map(String) : [],
    clarification_question: answer.clarification_question ?? null,
    sources: [...new Set(sources)],
    checks,
    metadata_status: DOCUMENT_STATUS,
    model: config.modelName,
    mode: 'agent',
    usage,
    retrieved_tables: retrievedTables,
    agent_trace: trace,
  };
}

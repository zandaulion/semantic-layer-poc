import { config } from './config.js';
import { contextForHits } from './catalog.js';
import { expandSearchQuery } from './elastic.js';
import { checkSql } from './sql-check.js';

const responseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['draft', 'needs_clarification', 'unsupported'] },
    sql: { type: 'string' },
    interpretation: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    clarification_question: { type: ['string', 'null'] },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'sql', 'interpretation', 'assumptions', 'clarification_question', 'sources'],
  additionalProperties: false,
};

function renderContext(context) {
  const tableText = context.tables.map((table) => {
    const columns = table.columns.map((column) => `${column.column_name} ${column.data_type}`).join(', ');
    return `ID table.bank_dwh.${table.table_name}\n${table.table_type.toUpperCase()} bank_dwh.${table.table_name}\nGrain: ${table.grain}\nColumns: ${columns}`;
  }).join('\n\n');
  const joins = context.relationships.map((relation) =>
    `CANDIDATE: bank_dwh.${relation.from_table}.${relation.from_column} = bank_dwh.${relation.to_table}.${relation.to_column}`,
  ).join('\n');
  return `${tableText}\n\nCandidate relationships (synthetic, not business-approved):\n${joins || '(none)'}`;
}

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function missingMonthYear(question) {
  if (/\b(?:19|20)\d{2}\b|\b(?:this|current|last|next|previous)\s+year\b/i.test(question)) return null;
  return months.find((month) => new RegExp(`\\b${month.slice(0, 3)}(?:${month.slice(3)})?\\b`, 'i').test(question)) || null;
}

function knownDefaultClientDraft(question, context) {
  if (!/\b(?:clients?|customers?)\b/i.test(question)
      || !/\b(?:in default|defaulted)\b/i.test(question)
      || !/\bend\s+of\b/i.test(question)) return null;
  const monthIndex = months.findIndex((month) => new RegExp(`\\b${month.slice(0, 3)}(?:${month.slice(3)})?\\b`, 'i').test(question));
  const years = [...new Set([...question.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => Number(match[0])))];
  if (monthIndex < 0 || years.length !== 1) return null;
  const required = {
    fact_loan_delinquency_daily: ['default_flag', 'customer_key', 'business_date_key'],
    dim_date: ['date_key', 'calendar_date', 'calendar_year_number', 'month_number'],
    dim_customer: ['customer_key', 'business_id', 'display_name'],
  };
  for (const [name, columns] of Object.entries(required)) {
    const table = context.tables.find((entry) => entry.table_name === name);
    if (!table || !columns.every((column) => table.columns.some((entry) => entry.column_name === column))) return null;
  }
  const count = /\b(?:count|number|how many)\b/i.test(question);
  const sql = `${count
    ? 'SELECT COUNT(DISTINCT c.business_id) AS clients_in_default'
    : 'SELECT DISTINCT c.business_id AS client_id, c.display_name AS client_name'}
FROM bank_dwh.fact_loan_delinquency_daily AS f
JOIN bank_dwh.dim_date AS d ON d.date_key = f.business_date_key
JOIN bank_dwh.dim_customer AS c ON c.customer_key = f.customer_key
WHERE f.default_flag = TRUE
  AND d.calendar_date = (
    SELECT MAX(snapshot_day.calendar_date)
    FROM bank_dwh.fact_loan_delinquency_daily AS snapshot_fact
    JOIN bank_dwh.dim_date AS snapshot_day ON snapshot_day.date_key = snapshot_fact.business_date_key
    WHERE snapshot_day.calendar_year_number = ${years[0]}
      AND snapshot_day.month_number = ${monthIndex + 1}
  )${count ? ';' : '\nORDER BY client_name, client_id;'}
`;
  return {
    sql,
    interpretation: `${count ? 'Counts distinct clients' : 'Lists clients'} with at least one loan delinquency row flagged as default at the latest available daily snapshot in ${months[monthIndex]} ${years[0]}.`,
    assumptions: [
      'default_flag = TRUE is a provisional POC definition of default; confirm the approved banking rule.',
      'The latest available daily snapshot in the requested month represents month end; confirm the month is complete.',
      'dim_customer.business_id identifies a client across customer dimension versions.',
    ],
    sources: Object.keys(required).map((name) => `table.bank_dwh.${name}`),
  };
}

export async function generateDraft({ question, previousSql = '', hits }) {
  const context = contextForHits(expandSearchQuery(question), hits);
  const retrievedTables = context.tables.map((table) => ({
    document_id: `table.bank_dwh.${table.table_name}`,
    table_name: table.table_name,
    title: table.table_name.replaceAll('_', ' '),
    grain: table.grain,
    domain_id: table.domain,
    table_type: table.table_type,
  }));
  if (!context.tables.length) {
    return {
      status: 'needs_clarification', sql: '', interpretation: '', assumptions: [],
      clarification_question: 'Which banking area or physical table should I use?',
      sources: [], checks: checkSql(''), metadata_status: 'synthetic_fixture',
    };
  }
  const defaultFact = context.tables.find((table) => table.table_name === 'fact_loan_delinquency_daily');
  const defaultColumns = new Set(defaultFact?.columns.map((column) => column.column_name) || []);
  const hasDefaultPath = /\bdefault(?:ed)?\b/i.test(question)
    && ['default_flag', 'customer_key', 'business_date_key'].every((column) => defaultColumns.has(column));
  const monthWithoutYear = missingMonthYear(question);
  if (monthWithoutYear) {
    return {
      status: 'needs_clarification', sql: '',
      interpretation: hasDefaultPath
        ? 'The synthetic catalog has fact_loan_delinquency_daily.default_flag for loan default, customer_key for the client, and business_date_key for the daily snapshot.'
        : 'The requested month needs a year before its date can be used in a SQL draft.',
      assumptions: hasDefaultPath ? ['Treat a client as in default when a loan delinquency row at month end has default_flag = TRUE; confirm this POC definition before production use.'] : [],
      clarification_question: `Which year do you mean for ${/\bend of\b/i.test(question) ? 'the end of ' : ''}${monthWithoutYear}?`,
      sources: hasDefaultPath ? ['table.bank_dwh.fact_loan_delinquency_daily'] : [],
      checks: null, retrieved_tables: retrievedTables, metadata_status: 'synthetic_fixture',
    };
  }
  const knownDraft = previousSql.trim() ? null : knownDefaultClientDraft(question, context);
  if (knownDraft) {
    return {
      status: 'draft', ...knownDraft, clarification_question: null,
      checks: checkSql(knownDraft.sql), retrieved_tables: retrievedTables,
      metadata_status: 'synthetic_fixture', model: 'catalog_rule',
    };
  }
  if (!config.modelApiKey) {
    return {
      status: 'error', code: 'model_unconfigured',
      message: 'The hosted model API key has not been configured on the server.',
      retrieved_tables: retrievedTables,
    };
  }
  const customer = context.tables.find((table) => table.table_name === 'dim_customer');
  const customerColumns = new Set(customer?.columns.map((column) => column.column_name) || []);
  const currentCustomerHint = /\bactive\b/i.test(question) && /\b(?:number|count|how many)\b/i.test(question)
    && ['business_id', 'is_current', 'is_active'].every((column) => customerColumns.has(column))
    ? 'For a current count of active customers, dim_customer has is_current, is_active, and business_id. Count distinct business_id to avoid counting SCD versions, and state that interpretation as an assumption.'
    : '';
  const defaultHint = hasDefaultPath
    ? 'For clients in default at a month end, use fact_loan_delinquency_daily.default_flag = TRUE on the specified business date, linked through business_date_key to dim_date and through customer_key to dim_customer when those dimensions are supplied. Count distinct clients. State that the default flag is a provisional POC definition.'
    : '';
  const prompt = [
    `User question: ${question}`,
    previousSql ? `Previous draft to revise: ${previousSql}` : '',
    'Target dialect: PostgreSQL. Schema: bank_dwh.',
    'Use only the supplied physical tables and columns. The relationships are synthetic candidates for this POC.',
    'Answer schema questions using the supplied metadata before asking the user. Client means customer in this catalog.',
    currentCustomerHint,
    defaultHint,
    'Do not invent a metric definition, date role, or join not supported by this context. Ask one focused question only if essential business meaning remains missing after checking the supplied tables and columns.',
    'Return one read-only SQL draft or a clarification. Never execute SQL.',
    renderContext(context),
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 40_000) {
    return {
      status: 'needs_clarification', sql: '', interpretation: '', assumptions: [],
      clarification_question: 'Which subject area should I use to narrow the schema context?',
      sources: [], checks: checkSql(''), retrieved_tables: retrievedTables,
      metadata_status: 'synthetic_fixture',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70_000);
  const requestBody = JSON.stringify({
    model: config.modelName,
    temperature: 0.1,
    max_completion_tokens: 1600,
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: 'You draft reviewable PostgreSQL SQL from supplied synthetic DWH metadata. Output only the requested JSON object. Resolve table and column questions from the supplied metadata; ask only when a necessary business rule is still unknown.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'sql_draft', strict: true, schema: responseSchema } },
  });
  let result;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${config.modelBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        const code = failure.error?.code || failure.error?.type || 'unknown';
        const reason = String(failure.error?.message || failure.message || 'request failed').slice(0, 300);
        if (response.status === 400 && attempt === 0) continue;
        const error = new Error(`Model API returned ${response.status} (${code}): ${reason}`);
        error.publicCode = 'model_provider_error';
        error.publicMessage = response.status === 429
          ? 'The model rate limit was reached. Wait a moment and try again.'
          : response.status === 401 || response.status === 403
            ? 'The hosted model key was rejected. Check the key on the server.'
            : 'The hosted model could not produce a draft for this request. Try a more specific question.';
        throw error;
      }
      const payload = await response.json();
      result = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!['draft', 'needs_clarification', 'unsupported'].includes(result.status)) throw new Error('Model response status is invalid');
  const allowedSources = new Set(context.tables.map((table) => `table.bank_dwh.${table.table_name}`));
  const sources = (Array.isArray(result.sources) ? result.sources : []).filter((id) => allowedSources.has(id));
  const checks = checkSql(result.sql);
  const status = result.status === 'draft' && (checks.statement === 'failed' || checks.tables !== 'passed') ? 'needs_revision' : result.status;
  return {
    status,
    sql: result.sql,
    interpretation: result.interpretation,
    assumptions: result.assumptions,
    clarification_question: result.clarification_question,
    sources,
    checks,
    metadata_status: 'synthetic_fixture',
    model: config.modelName,
    retrieved_tables: retrievedTables,
  };
}

import { config } from './config.js';
import { contextForHits, schemaName, DOCUMENT_STATUS } from './catalog.js';
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
    return `ID table.${schemaName}.${table.table_name}\n${table.table_type.toUpperCase()} ${schemaName}.${table.table_name}\nGrain: ${table.grain}\nColumns: ${columns}`;
  }).join('\n\n');
  const joins = context.relationships.map((relation) =>
    `CANDIDATE: ${schemaName}.${relation.from_table}.${relation.from_column} = ${schemaName}.${relation.to_table}.${relation.to_column}`,
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
FROM ${schemaName}.fact_loan_delinquency_daily AS f
JOIN ${schemaName}.dim_date AS d ON d.date_key = f.business_date_key
JOIN ${schemaName}.dim_customer AS c ON c.customer_key = f.customer_key
WHERE f.default_flag = TRUE
  AND d.calendar_date = (
    SELECT MAX(snapshot_day.calendar_date)
    FROM ${schemaName}.fact_loan_delinquency_daily AS snapshot_fact
    JOIN ${schemaName}.dim_date AS snapshot_day ON snapshot_day.date_key = snapshot_fact.business_date_key
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
    sources: Object.keys(required).map((name) => `table.${schemaName}.${name}`),
  };
}

function knownActiveCustomersLastMonthDraft(question, context) {
  if (!/^(?:(?:number of|count(?: of)?|how many)\s+)active\s+(?:customers?|clients?)\s+(?:last|previous)\s+month\??$/i.test(question.trim())) return null;
  const customer = context.tables.find((table) => table.table_name === 'dim_customer');
  const required = ['business_id', 'is_active', 'effective_from_date', 'effective_to_date'];
  if (!customer || !required.every((column) => customer.columns.some((entry) => entry.column_name === column))) return null;
  const monthEnd = "(date_trunc('month', CURRENT_DATE)::date - 1)";
  const sql = `SELECT COUNT(DISTINCT c.business_id) AS active_customers_last_month
FROM ${schemaName}.dim_customer AS c
WHERE c.is_active = TRUE
  AND c.effective_from_date <= ${monthEnd}
  AND (c.effective_to_date IS NULL OR c.effective_to_date > ${monthEnd});
`;
  return {
    sql,
    interpretation: 'Counts distinct customers active at the end of the previous calendar month using the historical customer dimension version valid on that date.',
    assumptions: [
      '“Last month” means the previous calendar month, evaluated when the SQL runs.',
      'Active means dim_customer.is_active = TRUE on the version valid at month end.',
      'effective_to_date is treated as an exclusive end date; confirm this SCD convention.',
      'business_id identifies a customer across dimension versions.',
    ],
    sources: [`table.${schemaName}.dim_customer`],
  };
}

function knownActiveCustomerTransactionDraft(question, context) {
  if (!/\bactive\s+(?:customers?|clients?)\b/i.test(question)
      || !/\btransactions?\b/i.test(question)
      || !/\b(?:total|sum|amount)\b/i.test(question)
      || !/\btransaction\s+types?\b/i.test(question)
      || /\b(?:payments?|atm|cards?|transfers?)\b/i.test(question)
      || /\b(?:today|yesterday|day|week|month|quarter|year|daily|weekly|monthly|quarterly|yearly|last|previous|this|since|between|through|20\d{2})\b/i.test(question)
      || missingMonthYear(question)) return null;
  const customer = context.tables.find((table) => table.table_name === 'dim_customer');
  const transaction = context.tables.find((table) => table.table_name === 'fact_account_transaction');
  const hasColumns = (table, names) => table && names.every((name) => table.columns.some((column) => column.column_name === name));
  if (!hasColumns(customer, ['customer_key', 'business_id', 'is_current', 'is_active'])
      || !hasColumns(transaction, ['customer_key', 'transaction_type_code', 'base_amount'])
      || !transaction.relationships.some((relation) => relation.to_table === 'dim_customer'
        && relation.from_column === 'customer_key' && relation.to_column === 'customer_key')) return null;
  return {
    sql: `WITH active_customers AS (
  SELECT DISTINCT business_id
  FROM ${schemaName}.dim_customer
  WHERE is_current = TRUE AND is_active = TRUE
)
SELECT t.transaction_type_code,
       COUNT(DISTINCT historical_customer.business_id) AS active_customer_count,
       SUM(t.base_amount) AS total_transaction_base_amount
FROM ${schemaName}.fact_account_transaction AS t
JOIN ${schemaName}.dim_customer AS historical_customer
  ON historical_customer.customer_key = t.customer_key
JOIN active_customers AS active_customer
  ON active_customer.business_id = historical_customer.business_id
GROUP BY t.transaction_type_code
ORDER BY t.transaction_type_code;`,
    interpretation: 'Counts currently active customers who have account transactions in each transaction type, and totals the transactions in the synthetic base amount.',
    assumptions: [
      '“Transactions” means account transactions; payment and ATM facts are not included.',
      'No period was specified, so the query uses all available account transaction history.',
      '“Active” means the current customer dimension version has is_current = TRUE and is_active = TRUE.',
      'base_amount is treated as a common reporting amount; confirm its currency definition before using the total.',
      'No transaction status or reversal filter was requested, so all recorded account transaction rows are included.',
      'Customers with no account transactions are absent from the per-type results.',
    ],
    sources: [`table.${schemaName}.fact_account_transaction`, `table.${schemaName}.dim_customer`],
  };
}

export async function generateDraft({ question, previousSql = '', hits }) {
  const context = contextForHits(expandSearchQuery(question), hits);
  const retrievedTables = context.tables.map((table) => ({
    document_id: `table.${schemaName}.${table.table_name}`,
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
      sources: [], checks: checkSql(''), metadata_status: DOCUMENT_STATUS,
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
      sources: hasDefaultPath ? [`table.${schemaName}.fact_loan_delinquency_daily`] : [],
      checks: null, retrieved_tables: retrievedTables, metadata_status: DOCUMENT_STATUS,
    };
  }
  const knownDraft = previousSql.trim() ? null
    : knownDefaultClientDraft(question, context)
      || knownActiveCustomersLastMonthDraft(question, context)
      || knownActiveCustomerTransactionDraft(question, context);
  if (knownDraft) {
    return {
      status: 'draft', ...knownDraft, clarification_question: null,
      checks: checkSql(knownDraft.sql), retrieved_tables: retrievedTables,
      metadata_status: DOCUMENT_STATUS, model: 'catalog_rule',
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
    `Target dialect: PostgreSQL. Schema: ${schemaName}.`,
    'Use only the supplied physical tables and columns. The relationships are synthetic candidates for this POC.',
    'Answer schema questions using the supplied metadata before asking the user. Client means customer in this catalog.',
    currentCustomerHint,
    defaultHint,
    'Do not invent a metric definition, date role, or join not supported by this context. If no period is stated, use all available rows and disclose that assumption. For an unqualified transaction request, prefer account transactions; do not ask about payment or ATM facts unless the user mentions them. Ask one focused question only if essential business meaning remains missing after checking the supplied tables and columns. Keep clarification_question under 160 characters, with no schema narrative or second question; put context in interpretation and assumptions.',
    'Return one read-only SQL draft or a clarification. Never execute SQL.',
    renderContext(context),
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 40_000) {
    return {
      status: 'needs_clarification', sql: '', interpretation: '', assumptions: [],
      clarification_question: 'Which subject area should I use to narrow the schema context?',
      sources: [], checks: checkSql(''), retrieved_tables: retrievedTables,
      metadata_status: DOCUMENT_STATUS,
    };
  }
  let usage = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);
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
    ...config.modelExtraBody,
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
      // A reply that hit the token limit is cut off mid-object and will not
      // parse. Say so, rather than letting it read as a server that ignored
      // the schema: under load, SGLang's default JSON grammar let the model
      // pad a finished answer with whitespace until it ran out of tokens.
      if (payload.choices?.[0]?.finish_reason === 'length') {
        const error = new Error('Model response was cut off at the token limit');
        error.publicCode = 'model_truncated';
        // What filled the budget, for evaluation: reasoning that never ended,
        // an answer padded with whitespace, or an answer that was simply long.
        // Lengths and the last few characters only, never the whole reply.
        const message = payload.choices[0].message ?? {};
        const reasoning = String(message.reasoning_content ?? message.reasoning ?? '');
        const content = String(message.content ?? '');
        error.detail = {
          completion_tokens: payload.usage?.completion_tokens ?? null,
          reasoning_chars: reasoning.length,
          content_chars: content.length,
          content_whitespace_chars: content.length - content.trimEnd().length,
          content_tail: content.trimEnd().slice(-120),
          content_head: content.slice(0, 120),
        };
        error.publicMessage = 'The model ran out of room before finishing the draft. Try again, or ask a narrower question.';
        throw error;
      }
      result = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
      // Reported so evaluation can size a prompt against an on-prem KV cache;
      // not every server returns it, so it stays optional.
      usage = payload.usage ?? null;
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!['draft', 'needs_clarification', 'unsupported'].includes(result.status)) throw new Error('Model response status is invalid');
  const allowedSources = new Set(context.tables.map((table) => `table.${schemaName}.${table.table_name}`));
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
    metadata_status: DOCUMENT_STATUS,
    model: config.modelName,
    usage,
    retrieved_tables: retrievedTables,
  };
}

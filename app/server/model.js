import { config } from './config.js';
import { contextForHits } from './catalog.js';
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

export async function generateDraft({ question, previousSql = '', hits }) {
  const context = contextForHits(question, hits);
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
  if (!config.modelApiKey) {
    return {
      status: 'error', code: 'model_unconfigured',
      message: 'The hosted model API key has not been configured on the server.',
      retrieved_tables: retrievedTables,
    };
  }
  const prompt = [
    `User question: ${question}`,
    previousSql ? `Previous draft to revise: ${previousSql}` : '',
    'Target dialect: PostgreSQL. Schema: bank_dwh.',
    'Use only the supplied physical tables and columns. The relationships are synthetic candidates for this POC.',
    'Do not invent a metric definition, date role, or join not supported by this context. Ask one focused question if essential business meaning is missing.',
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
  let result;
  try {
    const response = await fetch(`${config.modelBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.modelName,
        temperature: 0.1,
        max_completion_tokens: 1600,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: 'You draft reviewable PostgreSQL SQL from supplied synthetic DWH metadata. Output only the requested JSON object. When a business rule is unknown, ask rather than invent.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'sql_draft', strict: true, schema: responseSchema } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const code = failure.error?.code || failure.error?.type || 'unknown';
      const reason = String(failure.error?.message || failure.message || 'request failed').slice(0, 300);
      throw new Error(`Model API returned ${response.status} (${code}): ${reason}`);
    }
    const payload = await response.json();
    result = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
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

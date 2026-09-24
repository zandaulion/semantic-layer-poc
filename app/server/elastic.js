import { config } from './config.js';

export async function elasticRequest(path, { method = 'GET', body, contentType = 'application/json', timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.elasticUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': contentType },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`Elasticsearch ${response.status}: ${data.error?.reason || data.error?.type || 'request failed'}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchTables(question, domain = 'all', size = 12) {
  const filter = [{ term: { status: 'synthetic_fixture' } }];
  if (domain !== 'all') filter.push({ term: { domain_id: domain } });
  const result = await elasticRequest(`/${encodeURIComponent(config.elasticIndex)}/_search`, {
    method: 'POST',
    body: {
      size,
      _source: ['document_id', 'table_name', 'title', 'grain', 'domain_id', 'table_type'],
      query: {
        bool: {
          filter,
          must: [{ multi_match: {
            query: question,
            fields: ['table_name^6', 'title^4', 'column_names^3', 'search_text'],
            type: 'best_fields',
          } }],
        },
      },
    },
  });
  return result.hits.hits.map((hit) => ({ ...hit._source, score: hit._score }));
}

export async function elasticHealth() {
  try {
    const result = await elasticRequest('/_cluster/health', { timeoutMs: 3_000 });
    return { available: true, status: result.status };
  } catch {
    return { available: false, status: 'unavailable' };
  }
}

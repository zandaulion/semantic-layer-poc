import { config } from './config.js';
import { tables, tableDocument } from './catalog.js';
import { elasticRequest } from './elastic.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mapping = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    dynamic: 'strict',
    properties: {
      document_id: { type: 'keyword' },
      status: { type: 'keyword' },
      domain_id: { type: 'keyword' },
      document_type: { type: 'keyword' },
      table_name: { type: 'text', fields: { exact: { type: 'keyword' } } },
      title: { type: 'text' },
      grain: { type: 'text' },
      table_type: { type: 'keyword' },
      column_names: { type: 'text' },
      search_text: { type: 'text' },
      columns: { type: 'object', enabled: false },
      relationships: { type: 'object', enabled: false },
    },
  },
};

export async function ingest() {
  const physical = `banking-poc-${Date.now()}`;
  await elasticRequest(`/${physical}`, { method: 'PUT', body: mapping });
  const lines = [];
  for (const table of tables) {
    const doc = tableDocument(table);
    lines.push(JSON.stringify({ index: { _index: physical, _id: doc.document_id } }));
    lines.push(JSON.stringify(doc));
  }
  const bulk = await elasticRequest('/_bulk?refresh=true', {
    method: 'POST', body: `${lines.join('\n')}\n`, contentType: 'application/x-ndjson', timeoutMs: 60_000,
  });
  if (bulk.errors) throw new Error('Elasticsearch bulk indexing reported failures');
  const count = await elasticRequest(`/${physical}/_count`);
  if (count.count !== tables.length) throw new Error(`Expected ${tables.length} tables, found ${count.count}`);

  let oldIndices = [];
  try {
    oldIndices = Object.keys(await elasticRequest(`/_alias/${encodeURIComponent(config.elasticIndex)}`));
  } catch (error) {
    if (!String(error.message).startsWith('Elasticsearch 404:')) throw error;
  }
  const actions = [
    ...oldIndices.map((index) => ({ remove: { index, alias: config.elasticIndex } })),
    { add: { index: physical, alias: config.elasticIndex } },
  ];
  await elasticRequest('/_aliases', { method: 'POST', body: { actions } });
  return { index: physical, alias: config.elasticIndex, documents: count.count, previous_indices: oldIndices };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ingest().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

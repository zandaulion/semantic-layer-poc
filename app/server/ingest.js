import { config } from './config.js';
import { tables, tableDocument } from './catalog.js';
import { validateCatalog } from './catalog-schema.js';
import fs from 'node:fs';
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

// One index per ingestion means that without pruning every run leaves its
// predecessor behind holding a full copy of the catalogue.
//
// What may be deleted is defined positively: a name in the exact shape this
// module generates, stamped strictly earlier than the run doing the deleting,
// and carrying no alias. Nothing is selected by being "not the current one" --
// an index that merely starts with the same words, or one an operator has
// aliased for their own purposes, belongs to somebody else and is left alone.
const GENERATION = /^banking-poc-(\d+)$/;

/**
 * Indices that `current` supersedes, given the cluster's `<index>: {aliases}`
 * map. Pure, so the selection rule can be tested without a cluster.
 */
export function supersededIndices(aliasesByIndex, current) {
  const stamp = GENERATION.exec(current);
  if (!stamp) throw new TypeError(`Not an ingestion index name: ${current}`);
  const cutoff = Number(stamp[1]);
  return Object.entries(aliasesByIndex ?? {})
    .filter(([name, entry]) => {
      const generation = GENERATION.exec(name);
      // Strictly older: an index newer than this run belongs to a concurrent
      // ingestion, which is not ours to tidy up.
      if (!generation || Number(generation[1]) >= cutoff) return false;
      return Object.keys(entry?.aliases ?? {}).length === 0;
    })
    .map(([name]) => name)
    .sort();
}

// Pruning runs after the alias has moved, so a failure here leaves a correct
// cluster with extra indices in it -- untidy, not broken. It therefore reports
// instead of throwing: failing the ingestion at this point would misdescribe an
// ingestion that actually succeeded.
async function pruneSuperseded(current) {
  const deleted = [];
  const failed = [];
  let existing;
  try {
    existing = await elasticRequest('/banking-poc-*/_alias');
  } catch (error) {
    // A 404 means nothing matched. Any other failure means we cannot tell what
    // is safe to remove, and guessing is precisely what this must not do.
    if (!String(error.message).startsWith('Elasticsearch 404:')) {
      failed.push({ index: 'banking-poc-*', reason: error.message });
    }
    return { deleted, failed };
  }
  for (const index of supersededIndices(existing, current)) {
    try {
      await elasticRequest(`/${encodeURIComponent(index)}`, { method: 'DELETE' });
      deleted.push(index);
    } catch (error) {
      failed.push({ index, reason: error.message });
    }
  }
  return { deleted, failed };
}

export async function ingest() {
  // Checked here rather than only in the CLI, because this is the last point at
  // which a bad catalog is still a file on disk instead of an index that
  // answers questions badly.
  const { errors } = validateCatalog(JSON.parse(fs.readFileSync(config.catalogPath, 'utf8')));
  if (errors.length) {
    throw new Error(`The catalog at ${config.catalogPath} is not valid:\n  - ${errors.join('\n  - ')}`);
  }

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

  const pruned = await pruneSuperseded(physical);
  return {
    index: physical,
    alias: config.elasticIndex,
    documents: count.count,
    previous_indices: oldIndices,
    deleted_indices: pruned.deleted,
    ...(pruned.failed.length ? { delete_failures: pruned.failed } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ingest().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

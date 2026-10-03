/**
 * One question, answered by whichever mode is configured. The application and
 * the benchmark both come through here, so a benchmark run measures exactly
 * what a user of the same configuration would get.
 */

import { config } from './config.js';
import { runAgent } from './agent.js';
import { searchTables } from './elastic.js';
import { generateDraft } from './model.js';

export async function answerQuestion({ question, domain = 'all', previousSql = '', history = [], runSql = null, onEvent = () => {}, mode = config.answerMode }) {
  if (mode === 'agent') return runAgent({ question, domain, previousSql, history, runSql, onEvent });
  onEvent({ type: 'tool_call', name: 'search_tables', arguments: { query: question, domain } });
  const hits = await searchTables(question, domain);
  onEvent({ type: 'tool_result', name: 'search_tables', summary: `${hits.length} tables` });
  const result = await generateDraft({ question, previousSql, hits });
  return result.status === 'error' ? result : { ...result, mode: 'pipeline' };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectDir = path.dirname(appDir);

export const config = {
  appDir,
  projectDir,
  webDir: path.join(appDir, 'web'),
  dataDir: process.env.DATA_DIR || path.join(appDir, 'data'),
  catalogPath: process.env.CATALOG_PATH || path.join(projectDir, 'banking-poc', 'catalog.json'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4387),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  cookieSecure: process.env.COOKIE_SECURE !== '0',
  elasticUrl: (process.env.ELASTICSEARCH_URL || 'http://127.0.0.1:9200').replace(/\/+$/, ''),
  elasticIndex: process.env.ELASTICSEARCH_INDEX || 'banking-poc-current',
  modelBaseUrl: (process.env.MODEL_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  modelName: process.env.MODEL_NAME || 'openai/gpt-oss-20b',
  modelApiKey: process.env.MODEL_API_KEY || process.env.GROQ_API_KEY || '',
  // A hosted provider answers in under a second; a model served from CPU on
  // modest hardware can take minutes for the same prompt. The budget has to
  // move with the backend, or a slow server is misreported as a broken one.
  modelTimeoutMs: Number(process.env.MODEL_TIMEOUT_MS) > 0 ? Number(process.env.MODEL_TIMEOUT_MS) : 70_000,
  // Fields a particular model needs in every request and the OpenAI shape has
  // no name for, such as Qwen's `chat_template_kwargs` to switch its thinking
  // mode off. A JSON object, merged over the request the server builds.
  modelExtraBody: parseExtraBody(process.env.MODEL_EXTRA_BODY),
  // pipeline: retrieval assembles the context, one model call drafts.
  // agent: the model looks tables up with tools and tests its drafts.
  answerMode: process.env.ANSWER_MODE === 'agent' ? 'agent' : 'pipeline',
  // The agent's catalog files. Empty writes them from CATALOG_PATH into a
  // temporary directory; set it to use files maintained elsewhere.
  catalogYamlDir: process.env.CATALOG_YAML_DIR || '',
  domainRulesPath: process.env.DOMAIN_RULES_PATH || path.join(projectDir, 'banking-poc', 'domain-rules.md'),
  // The same rules in the pipeline's prompt: off by default, so the
  // pipeline's recorded results stay comparable; on, to measure what the rules
  // alone are worth.
  pipelineDomainRules: process.env.PIPELINE_DOMAIN_RULES === '1',
  agentMaxSteps: Number(process.env.AGENT_MAX_STEPS) > 0 ? Number(process.env.AGENT_MAX_STEPS) : 12,
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS) > 0 ? Number(process.env.AGENT_TIMEOUT_MS) : 180_000,
  agentContextChars: Number(process.env.AGENT_CONTEXT_CHARS) > 0 ? Number(process.env.AGENT_CONTEXT_CHARS) : 60_000,
  // "required" makes every reply a tool call, so the only way to finish is
  // submit_answer. "auto" for a server that does not support it.
  agentToolChoice: process.env.AGENT_TOOL_CHOICE || 'required',
  // The warehouse drafts are run against, read-only: a postgres:// URL for a
  // user that can only read. Empty turns execution off.
  dwhUrl: process.env.DWH_URL || '',
  // What the agent's run_sql may do. run: execute and show up to 20 rows.
  // explain: EXPLAIN only, so the agent learns whether its SQL is valid and
  // what it returns, but never sees a row -- for a warehouse whose data the
  // model must not read.
  agentSqlCheck: process.env.AGENT_SQL_CHECK === 'explain' ? 'explain' : 'run',
  dwhMaxRows: Number(process.env.DWH_MAX_ROWS) > 0 ? Number(process.env.DWH_MAX_ROWS) : 200,
  // The directory shared with the benchmark daemon on the host; empty turns
  // the Run tab off. Device ids allowed to start runs, comma separated: runs
  // rent GPUs, so the default is nobody.
  benchDir: process.env.BENCH_DIR || '',
  benchRunnerDevices: (process.env.BENCH_RUNNER_DEVICES || '').split(',').map((v) => v.trim()).filter(Boolean),
};

function parseExtraBody(text) {
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_EXTRA_BODY must be a JSON object');
  return value;
}

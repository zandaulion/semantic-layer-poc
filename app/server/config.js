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
};

function parseExtraBody(text) {
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_EXTRA_BODY must be a JSON object');
  return value;
}

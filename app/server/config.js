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
};

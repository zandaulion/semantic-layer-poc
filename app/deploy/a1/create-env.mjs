import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hostname = process.argv[2];
if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) {
  console.error('Usage: node create-env.mjs <tailnet-hostname>');
  process.exit(2);
}
const directory = path.join(os.homedir(), '.config', 'banking-sql-poc');
const filename = path.join(directory, 'server.env');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(os.homedir(), '.local', 'share', 'banking-sql-poc'), { recursive: true, mode: 0o700 });
if (fs.existsSync(filename)) {
  console.error(`Environment file already exists: ${filename}`);
  process.exit(1);
}
const lines = [
  'HOST=127.0.0.1',
  'PORT=4387',
  `PUBLIC_BASE_URL=https://${hostname}:8443`,
  `DATA_DIR=${path.join(os.homedir(), '.local', 'share', 'banking-sql-poc')}`,
  'ELASTICSEARCH_URL=http://127.0.0.1:9200',
  'ELASTICSEARCH_INDEX=banking-poc-current',
  'MODEL_BASE_URL=https://api.groq.com/openai/v1',
  'MODEL_NAME=openai/gpt-oss-20b',
  `ADMIN_TOKEN=${crypto.randomBytes(32).toString('hex')}`,
  'GROQ_API_KEY=',
];
fs.writeFileSync(filename, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Created ${filename} with a random admin token. Add GROQ_API_KEY privately when available.`);

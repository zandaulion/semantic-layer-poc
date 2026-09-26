import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../server/config.js';
import { benchRequest, mayRunBench } from '../server/bench-runner.js';

async function withExchange(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-'));
  await mkdir(path.join(dir, 'requests'));
  await mkdir(path.join(dir, 'responses'));
  const saved = config.benchDir;
  config.benchDir = dir;
  try { await run(dir); } finally { config.benchDir = saved; await rm(dir, { recursive: true, force: true }); }
}

test('a request is written for the daemon and its answer read back', async () => {
  await withExchange(async (dir) => {
    // A stand-in daemon: answer the first request that appears.
    const daemon = (async () => {
      for (;;) {
        const [file] = (await readdir(path.join(dir, 'requests'))).filter((f) => !f.startsWith('.'));
        if (file) {
          const request = JSON.parse(await readFile(path.join(dir, 'requests', file), 'utf8'));
          await writeFile(path.join(dir, 'responses', file), JSON.stringify({ status: 200, body: { echo: request } }));
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const reply = await benchRequest('POST', '/validate', { model: 'x/y' });
    await daemon;
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.echo, { method: 'POST', path: '/validate', body: { model: 'x/y' } });
    assert.deepEqual(await readdir(path.join(dir, 'responses')), [], 'the answer is removed once read');
  });
});

test('with no daemon the request times out, says so, and is taken back', async () => {
  await withExchange(async (dir) => {
    const reply = await benchRequest('GET', '/status', undefined, 300);
    assert.equal(reply.status, 503);
    assert.deepEqual((await readdir(path.join(dir, 'requests'))).filter((f) => !f.startsWith('.')), []);
  });
});

test('only listed devices may start runs', () => {
  const saved = config.benchRunnerDevices;
  config.benchRunnerDevices = ['d87f-allowed'];
  try {
    assert.equal(mayRunBench({ id: 'd87f-allowed' }), true);
    assert.equal(mayRunBench({ id: 'someone-else' }), false);
    assert.equal(mayRunBench(null), false);
  } finally { config.benchRunnerDevices = saved; }
});

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * The PWA's line to the benchmark daemon on the host (eval/bench/daemon.mjs).
 * The daemon holds the RunPod key and does the renting; this side only
 * decides who may ask. They share a directory mounted into this container:
 * a request is written to requests/, and its answer appears in responses/.
 */
export function benchAvailable() {
  return Boolean(config.benchDir);
}

/** Only the devices listed in BENCH_RUNNER_DEVICES may start runs: they cost money. */
export function mayRunBench(device) {
  return Boolean(device) && config.benchRunnerDevices.includes(String(device.id));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function benchRequest(method, route, body, timeoutMs = 30_000) {
  const id = `${randomUUID()}.json`;
  const requests = path.join(config.benchDir, 'requests');
  const answer = path.join(config.benchDir, 'responses', id);
  try {
    const temporary = path.join(requests, `.${id}`);
    await writeFile(temporary, JSON.stringify({ method, path: route, body }));
    await rename(temporary, path.join(requests, id));
  } catch {
    return { status: 503, body: { error: 'bench_unavailable', message: 'The benchmark exchange directory is not mounted.' } };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse(await readFile(answer, 'utf8'));
      await rm(answer, { force: true });
      return reply;
    } catch {
      await sleep(150);
    }
  }
  // Nobody answered: take the request back so a daemon started later does not act on it.
  await rm(path.join(requests, id), { force: true });
  return { status: 503, body: { error: 'bench_unavailable', message: 'The benchmark service on the host is not answering.' } };
}

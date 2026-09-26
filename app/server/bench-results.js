import fs from 'node:fs';
import path from 'node:path';

/**
 * The model benchmark's recorded runs, shaped for the PWA's results tab.
 *
 * Reads the result files eval/bench/bench.mjs writes. Only runs at the top of
 * the results directory are listed: quick smoke tests and superseded attempts
 * live in subdirectories and stay out, as they do in the command-line table.
 * The drafted SQL is left behind; the tab shows outcomes, not queries.
 */
export function loadBenchResults(appDir) {
  const dir = path.join(appDir, 'eval', 'bench', 'results');
  const casesFile = path.join(appDir, 'eval', 'bench', 'cases.json');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { runs: [], questions: [] };
  }
  const bench = JSON.parse(fs.readFileSync(casesFile, 'utf8')).cases;
  const questions = bench.map(({ id, tier, question }) => ({ id, tier, question }));

  const runs = files.map((file) => {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const peak = Math.max(r.throughput_qpm ?? 0, ...(r.load?.levels ?? []).map((l) => l.requests_per_minute));
    // Per question: how many of its repeats ended in each outcome.
    const outcomes = {};
    for (const a of r.answers ?? []) {
      if (a.tier === 'T0') continue;
      outcomes[a.id] ??= {};
      outcomes[a.id][a.outcome] = (outcomes[a.id][a.outcome] ?? 0) + 1;
    }
    return {
      id: file.replace(/\.json$/, ''),
      recorded_at: r.recorded_at,
      model: r.model.name,
      hf: r.model.hf,
      about: r.model.about,
      card: r.card,
      // Older result files recorded "vLLM (image)"; newer ones "vLLM v0.30.0".
      server: String(r.server ?? '').replace(/^vLLM \((?:[^:]+):([^)]+)\)$/, 'vLLM $1') || null,
      server_image: r.server_image ?? r.server?.match(/^vLLM \(([^)]+)\)$/)?.[1] ?? null,
      cloud: r.cloud,
      price_per_hour: r.price_per_hour,
      cost_usd: r.cost_usd,
      repeats: r.repeats,
      concurrency: r.concurrency,
      minutes: r.timings?.total_s ? Math.round(r.timings.total_s / 6) / 10 : null,
      questions_per_minute: peak ? Math.round(peak) : null,
      cost_per_1000: peak && r.price_per_hour ? Math.round((r.price_per_hour / (peak * 60)) * 1000 * 1000) / 1000 : null,
      note: r.note ?? null,
      summary: r.summary,
      outcomes,
    };
  });
  // Fast runs and runs stopped early: listed on their own, never in the
  // comparison, because ten questions asked once do not compare with 46 asked
  // three times.
  let quick = [];
  try {
    quick = fs.readdirSync(path.join(dir, 'quick')).filter((f) => f.endsWith('.json')).sort().reverse().map((file) => {
      const r = JSON.parse(fs.readFileSync(path.join(dir, 'quick', file), 'utf8'));
      return {
        id: file.replace(/\.json$/, ''), recorded_at: r.recorded_at, model: r.model.name, card: r.card,
        server: String(r.server ?? '').replace(/^vLLM \((?:[^:]+):([^)]+)\)$/, 'vLLM $1') || null,
        summary: r.summary, stopped_early: r.stopped_early ?? null, cost_usd: r.cost_usd ?? null,
        minutes: r.timings?.total_s ? Math.round(r.timings.total_s / 6) / 10 : null,
      };
    });
  } catch { /* no fast runs yet */ }
  return { runs, questions, quick };
}

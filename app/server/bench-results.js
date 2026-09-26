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
  return { runs, questions };
}

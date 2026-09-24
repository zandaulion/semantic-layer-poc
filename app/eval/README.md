# Backend evaluation

## Why this exists

The POC reaches its model through `MODEL_BASE_URL`, an OpenAI-compatible
`/chat/completions` endpoint. Moving from a hosted provider to an on-prem
inference server is therefore a one-line change — and that is exactly what makes
it tempting to assume the two behave the same.

They do not have to. The same weights served by a different runtime can differ in
quantisation, in how strictly a JSON schema is enforced during decoding, and in
whether vendor parameters like `reasoning_effort` are honoured or silently
ignored. None of those differences announce themselves. They arrive as a
different table in a join, or as a draft that no longer asks the clarifying
question, and a reviewer reading the SQL has no way to tell that the backend is
why.

So this harness runs the real pipeline against a fixed set of questions whose
correct answers the fixture schema already determines, and writes a result file.
Point it at two backends, compare the files, and the question stops being a
matter of opinion.

It is also the thing to run before accepting a model upgrade, a quantisation
change, or a prompt edit. The backend question is only its first use.

## Running it

Elasticsearch has no published port, so the harness runs inside the container
network:

```bash
podman exec banking-dwh node eval/run.mjs --label groq --out /tmp/groq.json
```

From a checkout with Elasticsearch reachable, `npm run eval` does the same.

| Flag | Effect |
| --- | --- |
| `--label NAME` | Names the run in the report and the result file |
| `--out FILE` | Writes the full result file, including every generated draft |
| `--case ID` | Runs one case; repeatable. Useful against a rate-limited account |
| `--cases FILE` | Uses a different expectation set. A variant catalog needs its own, because the tables it describes have different names |
| `--retrieval-only` | Measures search and context assembly without calling a model. Needs Elasticsearch, finishes in seconds |
| `--compare A B` | Diffs two result files instead of running anything |

The process exits non-zero if any case fails, so it can gate a backend change.

## Reading the report

```
  ✓ atm-by-branch                     draft               1014
  ✗ card-disputes                     -                   35825   PROVIDER_ERROR
  ✓ refuse-write                      needs_revision      598     model wrote DML; checker caught it
```

A case passes when three things hold: the pipeline returned the expected status,
the draft used the tables the question requires and none it was told to avoid,
and no write reached the user as a draft.

The summary line adds what the cases cannot say individually:

- **grounding** — how many answered cases selected the right tables. This is the
  number that tracks retrieval quality, and it is largely backend-independent.
- **latency p50/p95** — measured on the attempt that succeeded, excluding
  retrieval and any rate-limit backoff, so it is inference time and nothing else.
- **tokens** — mean prompt and completion size. The prompt figure is the one to
  carry into an on-prem sizing conversation: it multiplies by concurrent users
  against the KV cache, and it is the constraint that binds first.
- **model_emitted_write** — how often the model produced non-read-only SQL that
  the checker had to catch. Not a failure, but a direct measure of how much the
  safety net is being leaned on.

## Failure classes

The taxonomy matters more than the pass rate, because the classes mean very
different things:

| Class | Meaning |
| --- | --- |
| `schema_violation` | The server did not honour the strict JSON schema. **This is the portability canary.** The whole application is built on that contract, and a backend that enforces it loosely breaks the app rather than degrading it |
| `provider_error` | The endpoint refused the request — rate limit, auth, capacity. Operational, not behavioural |
| `timeout` | No answer within the client's 70-second budget. Worth watching on-prem, where the budget was calibrated against a much faster provider |
| `harness_error` | A defect here, not there |

Rate limits are retried with backoff rather than scored, because a run's pass
rate should not depend on how recently the last run happened. Nothing else is
retried: a schema violation is a result, and retrying it would hide the one
thing this harness exists to find.

## The ground truth

`cases.json` holds twelve questions spanning every domain in the fixture. Each
names the tables a correct answer must use.

These are derived from the schema rather than from taste. The facts carry only
`business_date_key` and no calendar date, so any question filtered to a year
*must* join `dim_date` — that is not a stylistic preference, it is the only way
to answer. Expectations come in three kinds:

- `required_tables` gate the case. Without them the draft is not answering the
  question that was asked.
- `preferred_tables` are reported but never fail a case. Grouping by a surrogate
  key instead of joining its dimension is a defensible alternative, not a defect,
  and a harness that punished it would generate false alarms until it was
  ignored.
- `forbidden_tables` encode instructions the system prompt actually gives — for
  an unqualified transaction question it says to prefer account transactions —
  so instruction-following is measured rather than assumed.

One case, `clients-in-default-month-end`, is answered by a deterministic catalog
rule that never calls a model. It is the control: if it moves when the backend
moves, the harness is wrong, not the model.

To add a case, name the question and the tables the schema forces. Prefer
questions where a wrong answer is wrong for a reason you can state.

## Serving a model locally

A second backend to compare against does not need a GPU. `gpt-oss-20b` is a
mixture-of-experts model with roughly 3.6B active parameters, which is the shape
that survives CPU inference, and the deployment includes a quadlet for it:

```bash
# ~12 GB, onto a filesystem with room -- not a small cache volume
mkdir -p ~/models && curl -fL --retry 5 -C - -o ~/models/gpt-oss-20b-MXFP4.gguf \
  https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-MXFP4.gguf

install -m 0644 app/deploy/quadlet/gpt-oss-local.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user start gpt-oss-local.service
```

MXFP4 is the quantisation gpt-oss ships in, so this is the model as released
rather than a further-compressed version of it — one fewer difference between
the two runs.

The unit deliberately has no `[Install]` section: it does not return after a
reboot unless asked for, because it is a tool rather than part of the service.
Stop it with `systemctl --user stop gpt-oss-local.service` when the comparison is
done; it is the largest thing on the host by memory.

Point a run at it without changing any stored configuration:

```bash
podman exec \
  -e MODEL_BASE_URL=http://gpt-oss-local:8080/v1 \
  -e MODEL_NAME=gpt-oss-20b \
  -e MODEL_API_KEY=local \
  -e MODEL_TIMEOUT_MS=900000 \
  banking-dwh node eval/run.mjs --label llamacpp-cpu --out /tmp/local.json
```

Two of those variables are not optional:

- `MODEL_API_KEY` must be non-empty. The server short-circuits without one and
  never makes the call, so a local endpoint that needs no key still needs a
  placeholder here.
- `MODEL_TIMEOUT_MS` has to be raised. The default 70 seconds was set against a
  provider answering in well under one; a case took about four and a half minutes
  on four Ampere cores. Leaving the default makes a slow backend look like a
  broken one, and the harness would record `timeout` for every case.

## Measuring retrieval on its own

`--retrieval-only` skips the model and reports two layers:

- **search recall** — required tables in the BM25 results.
- **context recall** — required tables that reach the prompt, after context
  assembly has walked the selected facts' declared relationships.

The gap between them is not noise. On the bundled fixture, search recall is
0.550 and context recall is 1.000: roughly half the grounding comes from the
join graph rather than from search, so a change that improved search metrics
while dropping the graph expansion would look like progress and be a regression.

`make-cryptic.mjs` builds a variant catalog whose table and column names are
abbreviated the way a real warehouse abbreviates them, translating the
expectations through the same map:

```bash
node eval/make-cryptic.mjs --out /tmp/cryptic
node eval/make-cryptic.mjs --out /tmp/cryptic-bare --strip-prose
# ingest each catalog, then
node eval/run.mjs --retrieval-only --cases /tmp/cryptic/cases.json
```

The findings from that sweep, and the two defects it exposed, are in
[retrieval and naming](../../retrieval-and-naming.md).

## Comparing two backends

```bash
podman exec banking-dwh node eval/run.mjs --label onprem --out /tmp/onprem.json
podman exec banking-dwh node eval/run.mjs --compare /tmp/groq.json /tmp/onprem.json
```

The diff reports every case that changed outcome, status, failure class, or table
selection. A changed table selection with an unchanged pass mark is the
interesting case: both backends answered acceptably but differently, which is the
drift that a pass rate alone would hide.

`baselines/` holds recorded runs kept as reference points: `groq-gpt-oss-20b.json`
and `llamacpp-cpu-mxfp4.json`, the same weights served two ways. They are records
of what each backend did on one day, not targets to hit.

## Results

[RESULTS.md](RESULTS.md) holds the recorded comparison: the same `gpt-oss-20b`
weights served by a hosted provider and by llama.cpp on four CPU cores. Its
tables are generated from the files in `baselines/` by `node eval/build-results.mjs`,
so no figure there is retyped; the reading of those figures is written by hand
underneath, in `results-discussion.md`.

In short: neither backend violated the JSON schema contract, both grounded every
answered case in the right tables, and they differed on which descriptive
dimensions they joined and on whether a destructive request was declined outright
or caught downstream by the SQL check.

## What it does not measure

Honest limits, so the numbers are not read for more than they carry:

- **Single-user latency only.** Every case runs sequentially. This says nothing
  about behaviour under concurrency, which is the question that actually decides
  on-prem capacity.
- **Table selection, not SQL correctness.** Nothing executes the generated SQL.
  Column choice, join direction, and business meaning are unverified — the same
  limits the PWA itself declares.
- **One fixture.** A synthetic 100-table warehouse with regular naming. A real
  warehouse with inconsistent names is a harder retrieval problem.
- **Twelve questions.** Enough to detect a backend that behaves differently, not
  enough to certify one that behaves well.

## Defects it found in the POC itself

Separately from the backend comparison, the harness's first run surfaced two
problems in production code:

1. `checkSql` read the column after `EXTRACT(YEAR FROM …)` as a table name, so a
   correct year filter was reported as touching an unknown table and downgraded
   to `needs_revision` in the PWA. `EXTRACT` is the ordinary way to filter by
   year against this schema, so the false positive was reachable by a plain
   question. Fixed, with regression tests covering `SUBSTRING`, `TRIM`, and
   `POSITION`, which borrow `FROM` and `IN` the same way.
2. The model did not refuse a request to delete duplicate customers; it wrote the
   `DELETE` and the statement check caught it. Nothing unsafe reached the user,
   but the guard was what made that true — and [RESULTS.md](RESULTS.md) shows the
   other backend declining the same request outright, which is why that guard
   should be read as production-critical rather than as a formality.

Neither was visible from the PWA, and neither would have been found by asking
whether the application "works".

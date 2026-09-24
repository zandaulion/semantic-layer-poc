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

## Comparing two backends

```bash
podman exec banking-dwh node eval/run.mjs --label onprem --out /tmp/onprem.json
podman exec banking-dwh node eval/run.mjs --compare /tmp/groq.json /tmp/onprem.json
```

The diff reports every case that changed outcome, status, failure class, or table
selection. A changed table selection with an unchanged pass mark is the
interesting case: both backends answered acceptably but differently, which is the
drift that a pass rate alone would hide.

`baselines/groq-gpt-oss-20b.json` is a recorded run kept as a reference point. It
is a record of what one backend did on one day, not a target to hit.

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

## What it found on its first run

Both defects were in production code, not in the harness:

1. `checkSql` read the column after `EXTRACT(YEAR FROM …)` as a table name, so a
   correct year filter was reported as touching an unknown table and downgraded
   to `needs_revision` in the PWA. `EXTRACT` is the ordinary way to filter by
   year against this schema, so the false positive was reachable by a plain
   question. Fixed, with regression tests covering `SUBSTRING`, `TRIM`, and
   `POSITION`, which borrow `FROM` and `IN` the same way.
2. Asked to delete duplicate customers, the model produced a `DELETE … USING`
   statement behind a CTE. The statement check caught it and the status was
   downgraded, so nothing unsafe reached the user — but the model did not refuse,
   and on a backend where that check behaves differently it is the only thing
   standing between the request and executable DML.

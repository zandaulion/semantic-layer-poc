# Configuration

Every setting is an environment variable. There is no configuration file format
and no runtime settings UI; the deployment reads
`~/.config/banking-sql-poc/server.env` through the quadlet's `EnvironmentFile`.

## Reference

### Metadata

| Variable | Default | Effect |
| --- | --- | --- |
| `CATALOG_PATH` | `<repo>/banking-poc/catalog.json` | The warehouse metadata. See the [catalog contract](catalog-contract.md). Read once at startup and held in memory |

The SQL schema name is **not** an environment variable: it comes from the
catalog's `schema_name`, so the metadata and the schema it describes cannot drift
apart. It defaults to `bank_dwh` when the catalog omits it.

### Elasticsearch

| Variable | Default | Effect |
| --- | --- | --- |
| `ELASTICSEARCH_URL` | `http://127.0.0.1:9200` | Base URL. Trailing slashes are stripped. No authentication is sent |
| `ELASTICSEARCH_INDEX` | `banking-poc-current` | The **alias** searches run against, not a physical index |

Ingestion writes a new physical index named `banking-poc-<epoch-ms>`, moves this
alias onto it in one atomic `_aliases` call, then deletes the generations it
superseded. Readers therefore never observe a half-built index, and the cluster
holds one copy of the catalog rather than one per run.

The indexed `status` field is a constant, `synthetic_fixture`, written onto every
document and required by every search. It is deliberately not configurable:
a writer and a filter that disagree return an empty result set rather than an
error, which reads as "nothing matched" and is very hard to diagnose.

### Model

| Variable | Default | Effect |
| --- | --- | --- |
| `MODEL_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible endpoint. The request is `POST {base}/chat/completions` |
| `MODEL_NAME` | `openai/gpt-oss-20b` | Passed through as `model` |
| `MODEL_API_KEY` | — | Sent as `Authorization: Bearer`. **Must be non-empty**, or the server returns `model_unconfigured` without calling anything. A local endpoint that ignores keys still needs a placeholder |
| `GROQ_API_KEY` | — | Fallback for `MODEL_API_KEY` |
| `MODEL_TIMEOUT_MS` | `70000` | Client-side abort. Raise it substantially for CPU-served models: the same prompt that takes under a second hosted took about four and a half minutes on four CPU cores |
| `MODEL_EXTRA_BODY` | — | A JSON object merged over every request, for fields a particular model needs: `{"chat_template_kwargs":{"enable_thinking":false}}` for Qwen, `{"reasoning_effort":"none"}` for Mistral. The benchmark's model profiles set it per model |

The request also sends `temperature: 0.1`, `max_completion_tokens: 1600`,
`reasoning_effort: 'low'`, and `response_format` with a strict JSON schema.
`MODEL_EXTRA_BODY` can override any of them; the last two are the fields most
likely to be read differently by another server or model. Mistral models, for
one, refuse `reasoning_effort: 'low'` outright. See
[the evaluation harness](app/eval/README.md) and
[the model benchmark](app/eval/bench/README.md).

### Server and access

| Variable | Default | Effect |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. The container sets `0.0.0.0`, because a container that binds loopback is unreachable through its published port |
| `PORT` | `4387` | Listen port |
| `PUBLIC_BASE_URL` | — | Origin used when building invite links |
| `ADMIN_TOKEN` | — | Required by `/api/admin/*`. Without it the admin endpoints are unusable |
| `COOKIE_SECURE` | on unless `0` | Session cookies use the `__Host-` prefix and `Secure`, which a browser will not store over plain HTTP. Set `0` only for local HTTP development |
| `DATA_DIR` | `<app>/data` | SQLite database for devices, invites and history |

### Evaluation

The harness reads the same variables, so a run measures what the application
would do. Override per run rather than editing stored configuration:

```bash
podman exec \
  -e MODEL_BASE_URL=http://gpt-oss-local:8080/v1 \
  -e MODEL_NAME=gpt-oss-20b \
  -e MODEL_API_KEY=local \
  -e MODEL_TIMEOUT_MS=900000 \
  banking-dwh node eval/run.mjs --label local --out /tmp/local.json
```

`SMOKE_QUESTION` and `SMOKE_DOMAIN` are used only by
`app/deploy/a1/smoke-test.mjs`.

### Model benchmark

Read by the application, for the Model tests and Run a test tabs:

| Variable | Default | Effect |
| --- | --- | --- |
| `BENCH_DIR` | — | The directory shared with the benchmark daemon on the host. The quadlet mounts it at `/run/bench` and sets this. Empty turns the Run tab off; Model tests then reads the results built into the image |
| `BENCH_RUNNER_DEVICES` | — | Device ids, comma separated, that may start runs. Runs rent GPUs, so the default is nobody; the Run tab shows a device its own id. Belongs in the server's private environment file |

Read by the daemon (`app/eval/bench/daemon.mjs`) and by `bench.mjs` on the host:

| Variable | Default | Effect |
| --- | --- | --- |
| `RUNPOD_API_KEY` | `~/.config/runpod-api-key` | The RunPod API key. Prefer the file, mode 600: it is read, never printed |
| `OPENROUTER_API_KEY` | `~/.config/openrouter-api-key` | The OpenRouter key for closed models (`bench.mjs --openrouter`). Prefer the file, mode 600, and a credit limit on the key |
| `BENCH_DIR` | `~/.local/share/banking-bench` | Where the daemon reads requests and writes answers |
| `BENCH_DAILY_CAP_USD` | `5` | A run whose worst case would take the day past this is refused. On GPUs the day's spend is the higher of the daemon's ledger and RunPod's bill; OpenRouter runs are added on top, counted at their worst case before they start |
| `MODEL_RATE_LIMIT_ATTEMPTS` | `4` | How often a rate-limited question may wait for room; `bench.mjs --rate-limit-attempts` sets it for a run |

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Runs the server. `npm run dev` does the same with file watching |
| `npm test` | Unit and integration tests. No Elasticsearch or model needed |
| `npm run validate:catalog` | Checks the catalog before it is indexed |
| `npm run ingest` | Builds a new index, swaps the alias, prunes superseded generations |
| `npm run eval` | Scores the configured backend against the evaluation set |
| `npm run eval:load` | Measures the configured backend's latency and throughput under rising concurrency |
| `npm run eval:results` | Regenerates `app/eval/RESULTS.md` from the recorded baselines |
| `node eval/bench/bench.mjs --model NAME` | Benchmarks a model on a rented A100 and scores its SQL by running it. `--report` prints the table of runs. See [the model benchmark](app/eval/bench/README.md) |
| `app/deploy/a1/install-bench-daemon.sh` | Installs the benchmark daemon as a user service, for the PWA's Run a test tab |
| `./deploy.sh` | Tests, builds the image, installs the units, restarts, health-checks |

## Order of operations

Elasticsearch must be reachable before ingestion, and ingestion must have run
before search returns anything. The application starts and answers `/api/health`
regardless — which is deliberate, so a broken pair is diagnosable, but it means a
healthy process is not evidence of a working system. `/api/status`, behind the
invite gate, reports whether Elasticsearch is reachable and whether a model key
is configured.

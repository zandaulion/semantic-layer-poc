# Banking DWH Studio PWA

The app serves an installable PWA with an invite gate, synthetic catalog search, SQL drafting in two modes (an agent with lookup tools, or a retrieval pipeline), an editable SQL review panel that can run a draft read-only against a seeded warehouse, conversations and query history, plus two tabs for the model benchmark: recorded results, and running a new test. Node, Elasticsearch and the warehouse each run as a rootless container on the A1 host, on a private network between them. The browser talks only to the Node server; the model key stays on that host. There are no npm runtime dependencies.

## Local run

From this directory, run `npm test`, then `npm start`. The default listener is `127.0.0.1:4387`. Run `npm run ingest` after Elasticsearch is available. `GET /api/health` checks the Node process; `GET /api/status` behind the invite gate reports Elasticsearch and model configuration. The app needs HTTPS (or localhost) for service worker installation. `npm run eval` scores the model backend against the [evaluation set](eval/README.md); it needs Elasticsearch and a model key, and exits non-zero if a case fails. `npm run eval:load` measures the model backend's latency and throughput under rising concurrency. To compare against a locally served model or a rented GPU instead of the hosted one, see [the harness README](eval/README.md). The server itself generates one draft at a time for all users; a concurrent request gets `429 busy`. `ANSWER_MODE=agent` makes the agent the default, and `DWH_URL` (a read-only `postgres://` URL) turns on execution; without it there is no Run button and no `run_sql` tool. See [configuration](../configuration.md#answer-mode-and-agent).

The catalog is generated from [`../banking-poc/catalog.json`](../banking-poc/catalog.json). Indexing creates a new physical index and swaps `banking-poc-current` to it; it leaves any prior index for manual cleanup. Search uses Elasticsearch BM25 over 100 table documents. It does not index data rows or all 5,000 columns as separate documents. `POST /api/check` only checks a small set of read-only statement and physical table reference rules. It deliberately reports syntax, columns, business meaning, and execution as unverified.

## Query history

Each successful generation saves its question, subject area, and complete answer in the app's SQLite database under the registered device ID. This includes SQL drafts and clarification responses. The History button lists saved answers newest first, lets the user restore a response, and lets them delete individual entries. History survives PWA reloads and server restarts. It is available only to that registered device; deleting the device removes its history. The list loads 20 entries at a time. Earlier generations made before this feature was deployed are not backfilled, and manual edits to the SQL editor remain in the current tab's session storage rather than being added to history.

Answers from `/api/ask` also carry a conversation id. A follow-up in the same conversation is answered with its earlier questions and SQL in view; **New conversation** starts afresh. Separately, an append-only `audit_log` table records every question, every statement executed and by whom (the agent, the app after an answer, or the user's Run SQL), and every answer with its model, steps and token use. It is not tied to a device, so deleting a device or its history does not delete it. `GET /api/admin/audit` lists it behind the admin token.

## Model tests and Run a test

Two tabs beside **Draft SQL** serve the [model benchmark](eval/bench/README.md).

**Model tests** (`/#tests`) shows every recorded run in two tables, most correct
first in each. Cryptic names come first (`F_ACCT_BAL_D`, abbreviated as an
older warehouse names things, descriptions kept), then descriptive names
(`fact_account_balance_daily`). The questions, data and answers are the same
in both. Each run is tagged OPEN (teal) or CLOSED · API (violet),
with a matching stripe down its row: open weights could run on the bank's
own hardware, closed models only through their vendor's API. Each table shows accuracy
on questions with one right answer, confidently wrong drafts, questions about
missing data met with a question back, unsafe writes, speed and GPU cost, with
the card and vLLM version under each model. A model that could not be served
on its card is listed last, flagged DID NOT RUN, with the reason. Fast checks
have a table of their own, and a grid shows each question's outcome per run. **Export PDF** prints it
as an A4 landscape report. Any registered device can see it.

**Run a test** (`/#run`) runs an open-weights model on a rented GPU or a
closed model (Claude, Gemini, GPT) through OpenRouter. For a GPU run it checks
the model on Hugging Face, offers the cards with
room for it (the A100 by default), and starts a fast or full run with cryptic
(the default) or descriptive names, with live
progress and the result at the end. Only devices listed in
`BENCH_RUNNER_DEVICES` may use it, because runs spend money; others see their own
device id and a note saying so.

The app holds no RunPod key and runs no containers. A daemon on the host does:

```bash
app/deploy/a1/install-bench-daemon.sh      # needs ~/.config/runpod-api-key, mode 600
```

It runs as the `banking-bench` user service, one run at a time, stops a run at
15 or 25 minutes, and refuses a run that could take the day past
`BENCH_DAILY_CAP_USD` (default $5). The quadlet mounts its exchange directory at
`/run/bench`; without the daemon the Run tab says so and the rest of the app is
unaffected.

## Tests

`npm test` runs everything. No Elasticsearch, no model, and no network: the
model-facing tests exercise the request-building and response-handling code
rather than a provider.

| File | What it pins |
| --- | --- |
| `catalog.test.js` | Retrieval context for known question shapes |
| `catalog-schema.test.js` | Catalog validation: required fields, duplicate table names, relationships pointing outside the catalog, descriptions warning rather than failing |
| `schema-name.test.js` | That the SQL schema comes from the catalog, and that identifier case does not decide whether a draft is accepted |
| `context-assembly.test.js` | That a fact's dimensions reach the prompt whether or not their names are readable, and that the table budget holds |
| `sql-check.test.js` | Read-only enforcement, and that valid SQL is not reported as unsafe |
| `clarification.test.js` | Asking rather than guessing when a period is missing |
| `catalog-rules.test.js` | That a deterministic rule answers when the catalog has the columns it names, and stands down when it does not |
| `ingest.test.js` | Which index generations an ingestion may delete |
| `auth.test.js`, `server.test.js` | Invite gate, and the endpoints working together |

### The tests that exist because of a real catalog

Three of these pin behaviour that the bundled fixture cannot exercise, because
the fixture is lower-case and spells every name out. They were written after
[the naming experiment](../retrieval-and-naming.md) found the corresponding
defects, and they are the ones to keep if this code is ported.

**Names the catalog uses are not assumed to be readable.** `context-assembly.test.js`
builds the same small star schema twice — once as `fact_wire_transfer` joined to
`dim_date`, once as `F_WR_TRF` joined to `D_DT` — and asserts the date dimension
reaches the prompt in both. Selection used to score dimensions by word overlap
with the question plus a literal comparison against `dim_date`, so an
abbreviated catalog got no dimensions at all and drafts silently lost their
joins. The date join is declared *second* in the fixture on purpose, so
relationship ordering cannot make the test pass by accident.

**Identifier case does not decide correctness.** `schema-name.test.js` loads a
catalog declaring `BANK_DWH.D_CUST` and asserts that `BANK_DWH.D_CUST`,
`bank_dwh.d_cust` and `Bank_Dwh.D_Cust` are all accepted, and that the match is
reported under the catalog's own spelling. SQL identifiers are case-insensitive
unless quoted, so a model may return any casing; the check used to lower-case
references while the catalog was keyed by its own spelling, which rejected every
correct draft against an uppercase warehouse.

**Cryptic column names make the deterministic rules stand down.**
`catalog-rules.test.js` drafts the same question against the same three tables
twice, with columns readable and then abbreviated — `default_flag` becomes
`DFLT_FLG`, `business_date_key` becomes `BUS_DT_K`. The rule answers in the
first case and declines in the second, falling through to the model rather than
throwing or emitting SQL for columns that do not exist. Every such rule will be
in that position on a real catalog, so the graceful part is the behaviour worth
pinning. It needs no model: with no key configured, a rule that fires is visible
as `model: "catalog_rule"` and a fall-through as `model_unconfigured`.

**The schema name is the catalog's, not a literal.** The same file points
`CATALOG_PATH` at a catalog declaring `risk_mart` and asserts that documents,
titles and the known-table check all follow it, while a catalog omitting
`schema_name` still falls back to `bank_dwh`.

These three run in child processes, because the catalog resolves once when the
module is first imported and a different catalog therefore needs a different
process rather than a reload.

## A1 deployment

Both halves run as rootless Podman containers managed by Quadlet. `./deploy.sh`
from the repository root does the whole cycle: run the tests, build the image,
install the units, start Elasticsearch, wait for it, restart the warehouse,
then start the app and check its health. The first run also prepares the
warehouse (`app/deploy/a1/setup-warehouse.mjs`): its seed, a cryptic copy, a
read-only role, and two private environment files, `warehouse-pg.env` for the
database and `warehouse-app.env` (one read-only URL) for the app.

1. Ensure rootless Podman and enough RAM are available. Elasticsearch recommends `vm.max_map_count=1048576`. On Oracle Linux, set this persistently in `/etc/sysctl.d/99-banking-poc.conf` and load it with `sudo sysctl --system`.
2. Run `node app/deploy/a1/create-env.mjs https://your-public-pwa.example.com` to create a private environment file, mode `0600`, with a random `ADMIN_TOKEN`. Add the hosted model API key to that file when available. Do not put secrets in Git, shell history, or the PWA.
3. Run `./deploy.sh`. It installs four units from [`app/deploy/quadlet/`](deploy/quadlet): a private network, Elasticsearch, the warehouse (`banking-dwh-pg`), and the app.
4. Populate the index with `podman exec banking-dwh node server/ingest.js`. Re-run it after changing the catalog: each run builds a new index, moves the `banking-poc-current` alias onto it, and then deletes the generations it replaced, so repeated ingestion does not accumulate copies of the catalogue. The catalogue ships inside the image, so this needs no checkout on the host.
5. Publish a dedicated Cloudflare application route for the PWA hostname at path `/`, with HTTP service URL `http://127.0.0.1:4387`. The app also has a separate tailnet HTTPS route on port 8443 (`tailscale serve --bg --https=8443 http://127.0.0.1:4387`). Keep the existing tailnet port 443 route for the other PWAs. Set `PUBLIC_BASE_URL` to the public HTTPS origin so new invite URLs use it.
6. Run `sudo python3 app/deploy/a1/install-console-route.py` to add the `/dwh/api/*` route to the existing private Caddy listener and a Bank DWH Studio entry to the invite console. The script reads the private admin token, validates Caddy, creates backups, and reloads it. The console's route remains tailnet-only; the public app's admin endpoints return 404 without the token.

### Why the containers are arranged this way

**Elasticsearch publishes no port.** It runs with its own HTTP authentication
disabled, which is only defensible while nothing can reach it. Rather than bind
it to loopback and trust that, it is bound to nothing at all: the app container
reaches it by name over the private network, and the host cannot.

**The warehouse publishes no port and keeps nothing.** Like Elasticsearch it is
reachable only by name on the private network. Its data lives on a tmpfs and is
loaded from the seed at every start, so nothing a query could do outlives a
restart. The app gets only the read-only role's URL; the superuser password
stays in the database container's environment.

**The two data directories are siblings, never nested.** `:Z` gives a bind mount
a private SELinux label, so two containers relabelling overlapping paths take
the files from each other. With the index under the app's data directory,
mounting that directory into the app relabelled the index too and Elasticsearch
came back with a broken node lock and no master. The app keeps
`$HOME/.local/share/banking-sql-poc`; the index keeps
`$HOME/.local/share/banking-dwh-elasticsearch`.

**The app binds `0.0.0.0` inside its container.** The default of `127.0.0.1` is
right for a host process and wrong here: `PublishPort` forwards to the
container's external address, so a server on its private loopback is reachable
by nothing. The isolation is the network namespace, not the bind address.

**No in-image user.** Under rootless Podman, container-root is already the
unprivileged account that started the service. Dropping to a second uid inside
the image would map to a subordinate id that does not own the existing SQLite
database on the bind mount.

The public GitHub repository contains code and synthetic metadata only. The PWA shell is publicly reachable through Cloudflare, and its API requires a single-use invite. An invite registers one browser on one hostname; the console can revoke that device. The invite console and its admin proxy remain on the tailnet. `app/data/`, environment files, API keys, and the Elasticsearch volume are excluded from Git.

Run `node app/deploy/a1/smoke-test.mjs <tailnet-hostname> https://your-public-pwa.example.com` on the host to check the private invite route, public HTTPS registration, Elasticsearch search, and SQL checks. Add `--generate` to exercise the hosted model as well. It creates a labeled test invite and deletes its test device afterward. The used invite remains in the audit list.

## Model provider

The default `MODEL_BASE_URL` uses Groq's OpenAI-compatible chat completions API with `openai/gpt-oss-20b`. The request uses strict JSON schema output and low reasoning effort. Other providers need support for those request fields; `MODEL_EXTRA_BODY` overrides or adds fields for a model that needs them (Mistral models refuse `reasoning_effort: "low"`, Qwen's thinking mode is switched off through `chat_template_kwargs`), and anything beyond that needs an adapter in `server/model.js`. Costs, limits, and availability depend on the provider account.

For the POC example “clients in default at end of August,” the app resolves the default flag and date relationship from the synthetic catalog, asks for a missing year, and uses a catalog-checked SQL rule after a year is supplied. The rule treats the latest available daily snapshot in that month as month end and labels the default definition as provisional. Other requests continue through the hosted model.

The example “number of active customers last month” also uses a catalog-checked rule. It counts distinct business IDs in the customer dimension version valid at the end of the previous calendar month, with `is_active = TRUE`. Review notes state the month-end and exclusive effective-to-date assumptions. This rule uses the dimension's historical effective dates; it does not infer customer activity from account relationships.

## PWA framework attribution

`web/sw.js`, `web/sw-update.js`, `web/pwa-update.js`, and `web/bust.html` come from [pwa-kit](https://github.com/zandaulion/pwa-kit) at commit `e2ad9dced4f471afb3d307b00af214dacd0d2e6e`, with the service worker adapted to avoid caching cross-origin requests and invite links and the page updater adapted to check while the app stays open. The invite endpoints follow [pwa-invite-console](https://github.com/zandaulion/pwa-invite-console) at commit `18b45653ff1a48d0336c61951d91821044957337`. No console files are copied into this repository.

The app checks for PWA updates at startup, on foreground return, and every minute while visible. It saves the current question, SQL, subject area, retrieved context, and review notes in the current tab's session storage so the kit can reload after an update without discarding a draft. An in-progress request still delays the reload until it finishes. If a device is stuck on code from before this behavior was deployed, open `/bust` once to clear its cached app shell and re-register the service worker.

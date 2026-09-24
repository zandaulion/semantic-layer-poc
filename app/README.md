# Banking DWH Studio PWA

The app serves an installable PWA with an invite gate, synthetic catalog search, GPT-OSS SQL drafting, an editable SQL review panel, and query history. Node and Elasticsearch each run as a rootless container on the A1 host, on a private network between them. The browser talks only to the Node server; the model key stays on that host. There are no npm runtime dependencies.

## Local run

From this directory, run `npm test`, then `npm start`. The default listener is `127.0.0.1:4387`. Run `npm run ingest` after Elasticsearch is available. `GET /api/health` checks the Node process; `GET /api/status` behind the invite gate reports Elasticsearch and model configuration. The app needs HTTPS (or localhost) for service worker installation.

The catalog is generated from [`../banking-poc/catalog.json`](../banking-poc/catalog.json). Indexing creates a new physical index and swaps `banking-poc-current` to it; it leaves any prior index for manual cleanup. Search uses Elasticsearch BM25 over 100 table documents. It does not index data rows or all 5,000 columns as separate documents. `POST /api/check` only checks a small set of read-only statement and physical table reference rules. It deliberately reports syntax, columns, business meaning, and execution as unverified.

## Query history

Each successful generation saves its question, subject area, and complete answer in the app's SQLite database under the registered device ID. This includes SQL drafts and clarification responses. The History button lists saved answers newest first, lets the user restore a response, and lets them delete individual entries. History survives PWA reloads and server restarts. It is available only to that registered device; deleting the device removes its history. The list loads 20 entries at a time. Earlier generations made before this feature was deployed are not backfilled, and manual edits to the SQL editor remain in the current tab's session storage rather than being added to history.

## A1 deployment

Both halves run as rootless Podman containers managed by Quadlet. `./deploy.sh`
from the repository root does the whole cycle: run the tests, build the image,
install the units, start Elasticsearch, wait for it, then start the app and
check its health.

1. Ensure rootless Podman and enough RAM are available. Elasticsearch recommends `vm.max_map_count=1048576`. On Oracle Linux, set this persistently in `/etc/sysctl.d/99-banking-poc.conf` and load it with `sudo sysctl --system`.
2. Run `node app/deploy/a1/create-env.mjs https://your-public-pwa.example.com` to create a private environment file, mode `0600`, with a random `ADMIN_TOKEN`. Add the hosted model API key to that file when available. Do not put secrets in Git, shell history, or the PWA.
3. Run `./deploy.sh`. It installs three units from [`app/deploy/quadlet/`](deploy/quadlet): a private network, Elasticsearch, and the app.
4. Populate the index with `podman exec banking-dwh node server/ingest.js`. Re-run it after changing the catalog. The catalogue ships inside the image, so this needs no checkout on the host.
5. Publish a dedicated Cloudflare application route for the PWA hostname at path `/`, with HTTP service URL `http://127.0.0.1:4387`. The app also has a separate tailnet HTTPS route on port 8443 (`tailscale serve --bg --https=8443 http://127.0.0.1:4387`). Keep the existing tailnet port 443 route for the other PWAs. Set `PUBLIC_BASE_URL` to the public HTTPS origin so new invite URLs use it.
6. Run `sudo python3 app/deploy/a1/install-console-route.py` to add the `/dwh/api/*` route to the existing private Caddy listener and a Bank DWH Studio entry to the invite console. The script reads the private admin token, validates Caddy, creates backups, and reloads it. The console's route remains tailnet-only; the public app's admin endpoints return 404 without the token.

### Why the containers are arranged this way

**Elasticsearch publishes no port.** It runs with its own HTTP authentication
disabled, which is only defensible while nothing can reach it. Rather than bind
it to loopback and trust that, it is bound to nothing at all: the app container
reaches it by name over the private network, and the host cannot.

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

The default `MODEL_BASE_URL` uses Groq's OpenAI-compatible chat completions API with `openai/gpt-oss-20b`. The request uses strict JSON schema output and low reasoning effort. Other providers need support for those request fields or an adapter in `server/model.js`. Costs, limits, and availability depend on the provider account.

For the POC example “clients in default at end of August,” the app resolves the default flag and date relationship from the synthetic catalog, asks for a missing year, and uses a catalog-checked SQL rule after a year is supplied. The rule treats the latest available daily snapshot in that month as month end and labels the default definition as provisional. Other requests continue through the hosted model.

The example “number of active customers last month” also uses a catalog-checked rule. It counts distinct business IDs in the customer dimension version valid at the end of the previous calendar month, with `is_active = TRUE`. Review notes state the month-end and exclusive effective-to-date assumptions. This rule uses the dimension's historical effective dates; it does not infer customer activity from account relationships.

## PWA framework attribution

`web/sw.js`, `web/sw-update.js`, `web/pwa-update.js`, and `web/bust.html` come from [pwa-kit](https://github.com/zandaulion/pwa-kit) at commit `e2ad9dced4f471afb3d307b00af214dacd0d2e6e`, with the service worker adapted to avoid caching cross-origin requests and invite links and the page updater adapted to check while the app stays open. The invite endpoints follow [pwa-invite-console](https://github.com/zandaulion/pwa-invite-console) at commit `18b45653ff1a48d0336c61951d91821044957337`. No console files are copied into this repository.

The app checks for PWA updates at startup, on foreground return, and every minute while visible. It saves the current question, SQL, subject area, retrieved context, and review notes in the current tab's session storage so the kit can reload after an update without discarding a draft. An in-progress request still delays the reload until it finishes. If a device is stuck on code from before this behavior was deployed, open `/bust` once to clear its cached app shell and re-register the service worker.

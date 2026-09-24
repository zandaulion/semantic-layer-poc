# Banking DWH Studio PWA

The app serves an installable PWA with an invite gate, synthetic catalog search, GPT-OSS SQL drafting, and an editable SQL review panel. Node 24.14+ and Elasticsearch run on the A1 host. The browser talks only to the Node server; the model key stays on that host. There are no npm runtime dependencies.

## Local run

From this directory, run `npm test`, then `npm start`. The default listener is `127.0.0.1:4387`. Run `npm run ingest` after Elasticsearch is available. `GET /api/health` checks the Node process; `GET /api/status` behind the invite gate reports Elasticsearch and model configuration. The app needs HTTPS (or localhost) for service worker installation.

The catalog is generated from [`../banking-poc/catalog.json`](../banking-poc/catalog.json). Indexing creates a new physical index and swaps `banking-poc-current` to it; it leaves any prior index for manual cleanup. Search uses Elasticsearch BM25 over 100 table documents. It does not index data rows or all 5,000 columns as separate documents. `POST /api/check` only checks a small set of read-only statement and physical table reference rules. It deliberately reports syntax, columns, business meaning, and execution as unverified.

## A1 deployment

1. Ensure Node 24.14+, rootless Podman, and enough RAM are available. Elasticsearch recommends `vm.max_map_count=1048576`. On Oracle Linux, set this persistently in `/etc/sysctl.d/99-banking-poc.conf` and load it with `sudo sysctl --system`.
2. Install the provided [`deploy/a1/banking-poc-elasticsearch.container`](deploy/a1/banking-poc-elasticsearch.container) as an unprivileged-user Quadlet. It pins an ARM64-capable Elasticsearch image, persists its data in a Podman volume, and publishes port 9200 only on `127.0.0.1`. Elasticsearch runs without its own HTTP authentication, which is only acceptable while the port stays bound to loopback: it must never be published on a public or tailnet address. It uses a 1 GiB JVM heap and 3 GiB container limit for this small metadata catalog.
3. Clone this repository under an unprivileged account. Run `npm run ingest` from `app` after Elasticsearch reports ready. Re-run it after changing the catalog.
4. Run `node deploy/a1/create-env.mjs <tailnet-hostname>` from `app` to create a private environment file owned by that account, mode `0600`, with a random `ADMIN_TOKEN`. Add the hosted model API key to that file when available. Do not put secrets in Git, shell history, or the PWA.
5. Install the provided [`deploy/a1/banking-sql-poc.service`](deploy/a1/banking-sql-poc.service) as an unprivileged-user systemd service. It binds Node to loopback and restarts on failure.
6. Expose the app over tailnet HTTPS on a separate port, for example `tailscale serve --bg --https=8443 http://127.0.0.1:4387`. Keep the existing port 443 route for the other PWAs. Set `PUBLIC_BASE_URL` to this HTTPS origin so invite URLs work.
7. Run `sudo python3 deploy/a1/install-console-route.py` from `app` to add the `/dwh/api/*` route to the existing private Caddy listener and a Bank DWH Studio entry to the invite console. The script reads the private admin token, validates Caddy, creates backups, and reloads it. The console's route must remain tailnet-only; the app's admin endpoints return 404 without the token.

The public GitHub repository contains code and synthetic metadata only. The PWA is reachable only by devices on the tailnet and then requires a single-use invite. An invite registers one browser; the console can revoke that device. `app/data/`, environment files, API keys, and the Elasticsearch volume are excluded from Git.

Run `node deploy/a1/smoke-test.mjs <tailnet-hostname>` on the host to check the HTTPS invite route, device registration, Elasticsearch search, and SQL checks. It creates a labeled test invite and deletes its test device afterward. The used invite remains in the audit list.

## Model provider

The default `MODEL_BASE_URL` uses Groq's OpenAI-compatible chat completions API with `openai/gpt-oss-20b`. The request uses strict JSON schema output and low reasoning effort. Other providers need support for those request fields or an adapter in `server/model.js`. Costs, limits, and availability depend on the provider account.

## PWA framework attribution

`web/sw.js`, `web/sw-update.js`, `web/pwa-update.js`, and `web/bust.html` come from [pwa-kit](https://github.com/zandaulion/pwa-kit) at commit `e2ad9dced4f471afb3d307b00af214dacd0d2e6e`, with the service worker adapted to avoid caching cross-origin requests and invite links. The invite endpoints follow [pwa-invite-console](https://github.com/zandaulion/pwa-invite-console) at commit `18b45653ff1a48d0336c61951d91821044957337`. No console files are copied into this repository.

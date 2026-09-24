#!/usr/bin/env bash
# Build and restart Bank DWH Studio and its Elasticsearch, both rootless.
#
# Caddy and the tunnel are configured separately and deliberately: changing
# either affects the other applications on this host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
ENV_FILE="${BANKING_DWH_ENV_FILE:-${CONFIG_ROOT}/banking-sql-poc/server.env}"
QUADLET_DIR="${CONFIG_ROOT}/containers/systemd"
DATA_DIR="${HOME}/.local/share/banking-sql-poc"
PORT="${BANKING_DWH_PORT:-4387}"

for executable in npm podman systemctl curl install; do
  command -v "$executable" >/dev/null || {
    echo "required executable not found: ${executable}" >&2
    exit 1
  }
done

[[ -f "$ENV_FILE" ]] || {
  echo "Missing ${ENV_FILE}. Create it with app/deploy/a1/create-env.mjs first." >&2
  exit 2
}
if ! grep -Eq '^ADMIN_TOKEN=.{32,}' "$ENV_FILE"; then
  echo "ADMIN_TOKEN is missing or too short in ${ENV_FILE}." >&2
  exit 2
fi

npm --prefix "$ROOT/app" test

# Built from the repository root: the server resolves its catalogue one level
# above itself, so `app/` alone is not a sufficient context.
podman build \
  --tag localhost/banking-dwh:latest \
  --file "$ROOT/app/deploy/Containerfile" \
  "$ROOT"

install -d -m 0700 "$DATA_DIR"
install -d -m 0755 "$QUADLET_DIR"
for unit in banking-dwh.network banking-poc-elasticsearch.container banking-dwh.container; do
  install -m 0644 "$ROOT/app/deploy/quadlet/${unit}" "${QUADLET_DIR}/${unit}"
done
systemctl --user daemon-reload

# Quadlet generates these units, and a generated unit cannot be enabled;
# `[Install] WantedBy=default.target` inside each file is what starts them at
# login. Elasticsearch first: the app answers its own health check without it
# and a broken pair would otherwise look deployed.
systemctl --user restart banking-poc-elasticsearch.service
for _ in $(seq 1 60); do
  podman exec banking-poc-elasticsearch \
    curl -fsS --max-time 2 http://127.0.0.1:9200/_cluster/health >/dev/null 2>&1 && break
  sleep 2
done
systemctl --user restart banking-dwh.service

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Deployed Bank DWH Studio; loopback health check passed."
    exit 0
  fi
  sleep 1
done

echo 'The image was built, but /api/health did not become ready.' >&2
systemctl --user --no-pager status banking-dwh.service >&2 || true
exit 1

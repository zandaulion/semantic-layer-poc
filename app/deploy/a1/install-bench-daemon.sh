#!/bin/sh
# Installs the benchmark daemon (app/eval/bench/daemon.mjs) as a systemd user
# service running from this checkout, so the PWA's "Run a test" tab can start
# benchmarks. Needs a RunPod API key in ~/.config/runpod-api-key (mode 600).
#
# The PWA reaches the daemon through ~/.local/share/banking-bench, which the
# banking-dwh quadlet mounts at /run/bench. Allow devices to start runs by
# listing their ids in BENCH_RUNNER_DEVICES in the server's environment file.
set -eu
checkout=$(cd "$(dirname "$0")/../../.." && pwd)
node=$(command -v node)
unit="$HOME/.config/systemd/user/banking-bench.service"
mkdir -p "$(dirname "$unit")" "$HOME/.local/share/banking-bench"
cat > "$unit" <<UNIT
[Unit]
Description=Model benchmark daemon for Bank DWH Studio
After=network-online.target

[Service]
WorkingDirectory=$checkout/app
ExecStart=$node $checkout/app/eval/bench/daemon.mjs
Environment=BENCH_DIR=%h/.local/share/banking-bench
# A run in progress owns a rented GPU. Stopping the service interrupts the run
# the way Ctrl-C would, which deletes the pod; give it time to do that.
KillSignal=SIGTERM
TimeoutStopSec=120
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now banking-bench.service
echo "installed $unit"

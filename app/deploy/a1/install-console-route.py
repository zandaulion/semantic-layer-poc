#!/usr/bin/env python3
"""Add this app to the existing tailnet-only invite console on the A1 host."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

CADDYFILE = Path('/etc/caddy/Caddyfile')
APPS = Path('/var/www/pwa-invite-console/apps.json')
ENVFILE = Path.home() / '.config/banking-sql-poc/server.env'
MARKER = '# Banking DWH Studio invite console route.'
ANCHOR = '\t# The train API, tailnet-only.'


def replacement_file(path, content):
    previous = path.stat()
    temporary = path.with_name(path.name + '.banking-poc-new')
    temporary.write_text(content)
    os.chown(temporary, previous.st_uid, previous.st_gid)
    os.chmod(temporary, previous.st_mode)
    temporary.replace(path)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo')
    if not all(path.exists() for path in (CADDYFILE, APPS, ENVFILE)):
        raise RuntimeError('Expected existing Caddyfile, invite console, and server environment file')
    match = re.search(r'^ADMIN_TOKEN=([a-f0-9]{64})$', ENVFILE.read_text(), re.MULTILINE)
    if not match:
        raise RuntimeError('Server admin token is missing or malformed')
    token = match.group(1)
    current = CADDYFILE.read_text()
    if MARKER not in current:
        if current.count(ANCHOR) != 1:
            raise RuntimeError('Cannot locate the private console route insertion point')
        route = (
            f'\t{MARKER}\n'
            '\thandle /dwh/api/* {\n'
            '\t\turi strip_prefix /dwh\n'
            '\t\treverse_proxy 127.0.0.1:4387 {\n'
            f'\t\t\theader_up X-Admin-Token {token}\n'
            '\t\t}\n'
            '\t}\n\n'
        )
        updated = current.replace(ANCHOR, route + ANCHOR)
    else:
        updated = current

    apps = json.loads(APPS.read_text())
    if not any(app.get('id') == 'dwh' for app in apps):
        apps.append({
            'id': 'dwh',
            'name': 'Bank DWH Studio',
            'api': '/dwh',
            'message': 'Bank DWH Studio POC access:\n\n1) Open {link}\n2) Install the app from your browser.\n3) Use the invite code to activate your device.\n\nThe code is valid for {days} days and registers one device.',
        })
    new_apps = json.dumps(apps, ensure_ascii=False, indent=2) + '\n'
    if updated == current and new_apps == APPS.read_text():
        print('Invite console route and app entry already installed.')
        return

    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backups = []
    for file in (CADDYFILE, APPS):
        backup = file.with_name(file.name + '.bak-banking-poc-' + stamp)
        shutil.copy2(file, backup)
        backups.append((file, backup))
    try:
        replacement_file(CADDYFILE, updated)
        replacement_file(APPS, new_apps)
        subprocess.run(['/usr/bin/caddy', 'validate', '--config', str(CADDYFILE)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=True)
    except Exception:
        for file, backup in backups:
            shutil.copy2(backup, file)
        subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy'], check=False)
        raise
    print('Installed Bank DWH Studio in the private invite console.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Console route installation failed: {error}', file=sys.stderr)
        sys.exit(1)

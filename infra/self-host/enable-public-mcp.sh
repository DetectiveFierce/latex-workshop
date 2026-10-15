#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
python3 - "$deploy_root" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import subprocess
from urllib.parse import urlsplit, urlunsplit
import sys

root = Path(sys.argv[1])
env_file = root / '.env'
lines = env_file.read_text().splitlines()
values = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
status = json.loads(subprocess.check_output(['tailscale', 'status', '--json']))
hostname = status['Self']['DNSName'].rstrip('.')
if not re.fullmatch(r'[a-zA-Z0-9.-]+\.ts\.net', hostname):
    raise SystemExit('Tailscale did not return a valid HTTPS hostname')
current = urlsplit(values.get('API_ORIGIN', ''))
if current.scheme != 'https' or current.hostname != hostname or current.username or current.password:
    raise SystemExit('API_ORIGIN must already use this node’s Tailscale HTTPS hostname')
public_origin = urlunsplit(('https', hostname + ':10000', current.path.rstrip('/'), '', ''))
updates = {
    'API_ORIGIN': public_origin,
    'AGENT_MCP_RESOURCE_URL': public_origin + '/api/mcp',
    'AGENT_MCP_ENABLED': 'true',
    'AGENT_MCP_DCR_ENABLED': 'true',
    'AGENT_MCP_REFRESH_TOKEN_TTL_DAYS': values.get('AGENT_MCP_REFRESH_TOKEN_TTL_DAYS', '365'),
    'PUBLIC_MCP_GATEWAY_ENABLED': 'true',
}
backup = env_file.with_name('.env.before-public-mcp-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
with backup.open('xb') as output:
    os.chmod(backup, 0o600)
    output.write(env_file.read_bytes())
next_env = env_file.with_name('.env.public-mcp.next')
with next_env.open('x') as output:
    os.chmod(next_env, 0o600)
    output.write('\n'.join(line for line in lines if line.partition('=')[0] not in updates) + '\n')
    output.write('\n'.join(key + '=' + value for key, value in updates.items()) + '\n')
next_env.replace(env_file)
print('Prepared public MCP gateway: ' + updates['AGENT_MCP_RESOURCE_URL'])
print('The Workshop website keeps its existing private WEB_ORIGIN. Deploy to activate the gateway.')
PY

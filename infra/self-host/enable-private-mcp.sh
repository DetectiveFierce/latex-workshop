#!/usr/bin/env bash
set -Eeuo pipefail

# Run on the deployment host once; subsequent releases preserve keys and revocations.
owner_email=${1:?Usage: enable-private-mcp.sh OWNER_EMAIL}
deploy_root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
[[ $owner_email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || exit 2
umask 077
mkdir -p "$deploy_root/runtime"
python3 - "$deploy_root" "$owner_email" <<'PY'
from pathlib import Path
import secrets
import sys
root, email = Path(sys.argv[1]), sys.argv[2]
p = root / '.env'
lines = p.read_text().splitlines()
values = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
if values.get('AGENT_MCP_ENABLED') != 'true':
    raise SystemExit('Enable AGENT_MCP_ENABLED before configuring private ingress')
if values.get('AGENT_MCP_PRIVATE_OWNER_EMAIL', email) != email:
    raise SystemExit('Existing private owner differs; refusing to remap access')
updates = {
    'AGENT_MCP_PRIVATE_OWNER_EMAIL': email,
    'AGENT_MCP_TAILNET_KEY': values.get('AGENT_MCP_TAILNET_KEY') or secrets.token_hex(32),
    'AGENT_MCP_TUNNEL_KEY': values.get('AGENT_MCP_TUNNEL_KEY') or secrets.token_hex(32),
}
for key in ('AGENT_MCP_TAILNET_KEY', 'AGENT_MCP_TUNNEL_KEY'):
    if len(updates[key]) != 64 or any(c not in '0123456789abcdef' for c in updates[key]):
        raise SystemExit('Existing private key is malformed')
backup = root / 'runtime' / 'env.before-private-mcp'
if not backup.exists():
    backup.write_bytes(p.read_bytes())
    backup.chmod(0o600)
lines = [line for line in lines if line.split('=', 1)[0] not in updates]
tmp = root / '.env.private-mcp.tmp'
tmp.write_text('\n'.join(lines + [f'{k}={v}' for k, v in updates.items()]) + '\n')
tmp.chmod(0o600)
tmp.replace(p)
keyfile = root / 'runtime' / 'tunnel-mcp-key'
keyfile.write_text(updates['AGENT_MCP_TUNNEL_KEY'])
keyfile.chmod(0o600)
PY

# SQL variables are quoted by psql. No token or password enters command-line arguments.
docker exec -i latex-workshop-postgres-1 sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=owner_email="$1"' \
  sh "$owner_email" <<'SQL'
begin;
select id as owner_id from users where email = :'owner_email' and email_verified = true \gset
insert into oauth_clients (id, client_id, user_id, name, redirect_uris, grant_types)
values
  (gen_random_uuid()::text, 'mind-palace-tailnet', :'owner_id', 'My Tailscale devices', '{}', '{}'),
  (gen_random_uuid()::text, 'mind-palace-chatgpt-tunnel', :'owner_id', 'My private ChatGPT tunnel', '{}', '{}')
on conflict (client_id) do nothing;
insert into agent_client_policies (user_id, client_id, all_projects)
values
  (:'owner_id', 'mind-palace-tailnet', true),
  (:'owner_id', 'mind-palace-chatgpt-tunnel', true)
on conflict (user_id, client_id) do nothing;
commit;
SQL
printf '%s\n' 'Private MCP credentials and connection grants configured. Deploy before enabling Serve.'

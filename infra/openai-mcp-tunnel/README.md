# Private ChatGPT MCP tunnel

This service connects the private LaTeX Workshop MCP endpoint to ChatGPT through OpenAI's Secure MCP Tunnel. It publishes no host ports. The tunnel process initiates outbound HTTPS connections to OpenAI and forwards the `main` channel only to the configured Tailscale HTTPS MCP URL.

The container uses host networking so it can resolve Tailscale MagicDNS and reach the host's Tailscale listener. Its health and admin listener remains loopback-only on `127.0.0.1:18080`. It receives no Linux capabilities, runs with `no-new-privileges`, and uses the local Caddy root certificate solely as an additional trust anchor for the private HTTPS origin.

## Configure

Create a tunnel and a standard project API key in the OpenAI Platform project associated with the target ChatGPT workspace. There is no separate "runtime API key" product: runtime credential here only means the project API key stored for exclusive use by the tunnel client. Its principal needs **Tunnels Read + Use**.

On the server, use the interactive configurator. It stores the key without placing it in shell history or Docker metadata:

```bash
./configure.sh tunnel_0123456789abcdef0123456789abcdef
```

The configurator creates two untracked files beside `compose.yml`:

```text
.env
secrets/control-plane-api-key
```

`.env` contains the non-secret tunnel ID:

```dotenv
OPENAI_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
PRIVATE_MCP_URL=https://mind-palace.tail7e24aa.ts.net/latex-workshop/api/mcp
CADDY_ROOT_CA_PATH=/home/mind-palace/data/caddy/caddy/pki/authorities/local/root.crt
TUNNEL_RUNTIME_UID=1000
TUNNEL_RUNTIME_GID=1000
```

`secrets/control-plane-api-key` contains only that project API key. Set its mode to `0600`.

The configurator also prints the protected-resource identifier used by ChatGPT for the tunnel. Set
that exact value as `AGENT_MCP_RESOURCE_URL` in the main LaTeX Workshop deployment. It has this
form (the hostname is intentionally OpenAI-owned even though the upstream application stays
private):

```dotenv
AGENT_MCP_RESOURCE_URL=https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_0123456789abcdef0123456789abcdef
```

Do not use the private Tailscale MCP URL for this setting when ChatGPT connects through the tunnel;
OAuth access tokens must use the same RFC 8707 resource identifier that ChatGPT sends. The tunnel's
`PRIVATE_MCP_URL` remains the private upstream destination.

## Operate

```bash
docker compose build --pull
docker compose up --detach
docker compose ps
docker compose logs --tail=100 tunnel-client
```

The container is ready only when its Docker health is `healthy`. It has no published ports. Its local operator page is available only on the server at `http://127.0.0.1:18080/ui` while the service is running.

# ChatGPT web rollout

LaTeX Workshop reaches ChatGPT through the production Streamable HTTP MCP endpoint. ChatGPT never needs local filesystem access: the workspace plugin supplies the workflow, and its registered app supplies authenticated project tools.

## 1. Choose public or private transport

For a private, Tailscale-only deployment, use OpenAI Secure MCP Tunnel. The repository includes a hardened, outbound-only service under `infra/openai-mcp-tunnel`. It reaches the Tailscale HTTPS MCP URL through host networking, trusts the local Caddy root, keeps its operator endpoint on loopback, and publishes no host ports. Keep the Mind Palace application, OAuth pages, and proposal review UI on Tailscale.

After configuring the tunnel, copy the protected-resource URL printed by `configure.sh` into the
main deployment `.env` as `AGENT_MCP_RESOURCE_URL`. ChatGPT sends that OpenAI gateway URL as the
OAuth `resource`; the private Tailscale URL remains `PRIVATE_MCP_URL` in the tunnel service. These
values intentionally differ.

For a publicly distributed plugin, verify production ingress instead. Public plugin submission requires a stable public HTTPS MCP endpoint; tunnel-backed apps are for private connections and developer-mode use.

For an owner-only private connection that should never prompt for Workshop reauthentication, use
[automatic private authentication](self-hosting.md#automatic-private-agent-authentication). The
file-backed tunnel credential authenticates discovery and tool calls; set that private app to
**No authentication** and refresh tools. Keep the existing tunnel/workspace association. Do not
apply that mode to a shared or public app.

### Direct authenticated gateway for Mind Palace

When the OpenAI tunnel is unavailable, the self-hosted deployment can expose a dedicated OAuth-protected gateway using Tailscale Funnel. A dedicated userspace Tailscale node serves standard HTTPS port 443; the existing host can also use port 10000. The Workshop website, REST project API, account login, storage, and private MCP ingress remain Tailscale-only. The gateway forwards only MCP, OAuth discovery, client registration, authorization, token exchange, revocation, authenticated OpenID user information, and public signing keys. It strips private transport credentials and Tailscale identity headers, so public requests always need normal OAuth authorization to access projects.

From the repository checkout, prepare the existing Mind Palace deployment over SSH, then deploy:

```bash
ssh mind-palace bash -s < infra/self-host/enable-public-mcp.sh
pnpm deploy:production
```

Enable Funnel in the tailnet policy for the Mind Palace node only: add a `nodeAttrs` entry targeting its Tailscale IP with `attr: ["funnel"]`. The default Funnel onboarding button instead grants that capability to every member. The operator must approve the scoped network-policy change before activation.

The preparation script backs up `.env`, preserves `WEB_ORIGIN`, selects the host's HTTPS port 10000, and enables `public-mcp`. For clients requiring standard HTTPS, enroll a dedicated `workshop-mcp` userspace node instead. Persist its state in `/home/mind-palace/services/latex-workshop/runtime/public-mcp-tailscale` (mode 700, owner 1000), grant Funnel only to that node's assigned IP, and configure:

```dotenv
PUBLIC_MCP_GATEWAY_ENABLED=true
PUBLIC_MCP_DEDICATED_TAILSCALE=true
API_ORIGIN=https://workshop-mcp.tail7e24aa.ts.net/latex-workshop
AGENT_MCP_RESOURCE_URL=https://workshop-mcp.tail7e24aa.ts.net/latex-workshop/api/mcp
```

The pinned, unprivileged `public-mcp-tailscale` service uses userspace networking, publishes no host ports, and forwards its HTTPS listener only to the isolated public MCP proxy. Enroll it once with `tailscale --socket=/tmp/tailscaled.sock up --hostname=workshop-mcp --advertise-tags=tag:server --accept-dns=false --accept-routes=false`; finish the owner login before deployment health verification. Back up the private node state with the host configuration and never include it in a release archive. Deployment preserves the node identity and activates Funnel on port 443 without changing existing host Serve routes. The browser-facing login and consent pages continue using the private website.

In ChatGPT, add a custom MCP server with **Server URL** set to the printed gateway URL and **OAuth** authentication. Connect once and select the authorized projects in Workshop's consent page. Request `offline_access` so ChatGPT can rotate access tokens automatically. Access tokens remain short-lived. Rotation renews the existing refresh-token retention window (one year by default), so active connections continue automatically; the owner can revoke the connection immediately under Account settings → Agent access. Do not choose **No authentication** for the public gateway.

Run the actual Nginx boundary tests before rollout:

```bash
node --test infra/openai-mcp-tunnel/public-gateway.test.mjs
```

### Public ingress configuration

Deploy with agent access enabled and the canonical public endpoint:

```dotenv
AGENT_MCP_ENABLED=true
AGENT_MCP_RESOURCE_URL=https://latex-workshop.example.com/api/mcp
AGENT_MCP_DCR_ENABLED=false
```

Replace the example hostname with the deployed Mind Palace origin. Route `/api/mcp`, `/api/auth/*`, and every `/.well-known/*` path to the API. Keep Client ID Metadata Documents (CIMD), PKCE `S256`, short-lived access tokens, rotating refresh tokens, and project-scoped consent enabled.

## 2. Register the ChatGPT app

1. In ChatGPT, enable **Settings → Security and login → Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, and create **Mind Palace LaTeX Workshop**. For a private deployment choose **Tunnel** and select the configured tunnel. For a public deployment, register the exact production `/api/mcp` URL.
3. Choose CIMD rather than dynamic client registration. Complete the OAuth flow and grant a non-production test project.
4. Exercise every tool and verify that `list_projects` returns `manageAccessUrl`, `edit_project` applies live source with an undo checkpoint, repeated edits see owner changes, and optional proposal handoff returns `reviewUrl` without applying source.
5. Copy the technical app id from the verified app registration. The underlying app id starts with `asdk_app_`; the browser plugin wrapper starts with `plugin_asdk_app_`.
6. Replace the app binding in `plugins/latex-workshop/.app.json` with that production app id. The id is deployment metadata, not a credential.

## 3. Import the workspace plugin

The bundled skill explicitly enables `allow_implicit_invocation`. Its description and the MCP
server instructions activate on LaTeX Workshop mentions or requests to edit or query LaTeX
files, including follow-ups about an established file. Generic proof checking or math help
alone does not activate the skill. Users do not need to invoke the skill explicitly.
An enabled app and its existing project grants remain necessary; invocation
rules do not bypass connection or authorization requirements.

1. Push the repository revision containing `.agents/plugins/marketplace.json` and `plugins/latex-workshop` to GitHub.
2. In **Admin → Plugins**, choose **Add → Import marketplace** and enter the repository URL. Leave **Path** empty because the marketplace is rooted at the repository root.
3. Open the imported **LaTeX Workshop** plugin, enable its registered app, and set the installation policy to **Installed** for eligible roles. GitHub import does not apply repository policy values automatically.
4. Set authentication to occur on first use. Configure action policies to allow the authorized read, direct-edit, compile, creation, rename, and optional proposal workflows without repeated confirmations. The server handles undo checkpoints and compare-and-swap conflict protection. Client action policies are independent of server-side proposal review; changing the MCP alone does not override a client confirmation policy.
5. On Enterprise/Edu, start with a pilot role. On Business, validate with workspace admins before enabling it for the workspace.

## 4. Acceptance check

Start a new ChatGPT web conversation after every app rescan or plugin sync. Run the cases in `plugins/latex-workshop/evals/golden-prompts.json` and record the selected tool, arguments, result, authorization behavior, and final link. Positive cases must call `list_projects` instead of producing a filesystem-access refusal; negative local-file and VS Code-extension cases must not activate the Mind Palace workflow.

After MCP tool metadata changes, refresh the app from ChatGPT Plugins. After skill or manifest changes, sync the GitHub marketplace and start another new conversation.

Official references: [connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), [MCP authentication](https://developers.openai.com/plugins/build/auth), and [workspace plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management).

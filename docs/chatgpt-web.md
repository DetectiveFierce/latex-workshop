# ChatGPT web rollout

LaTeX Workshop reaches ChatGPT through the production Streamable HTTP MCP endpoint. ChatGPT never needs local filesystem access: the workspace plugin supplies the workflow, and its registered app supplies authenticated project tools.

## 1. Choose public or private transport

For a private, Tailscale-only deployment, use OpenAI Secure MCP Tunnel. The repository includes a hardened, outbound-only service under `infra/openai-mcp-tunnel`. It reaches the Tailscale HTTPS MCP URL through host networking, trusts the local Caddy root, keeps its operator endpoint on loopback, and publishes no host ports. Keep the Mind Palace application, OAuth pages, and proposal review UI on Tailscale.

After configuring the tunnel, copy the protected-resource URL printed by `configure.sh` into the
main deployment `.env` as `AGENT_MCP_RESOURCE_URL`. ChatGPT sends that OpenAI gateway URL as the
OAuth `resource`; the private Tailscale URL remains `PRIVATE_MCP_URL` in the tunnel service. These
values intentionally differ.

For a publicly distributed plugin, verify production ingress instead. Public plugin submission requires a stable public HTTPS MCP endpoint; tunnel-backed apps are for private connections and developer-mode use.

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
4. Exercise every tool and verify that `list_projects` returns `manageAccessUrl`, proposal handoff returns `reviewUrl`, and accepted source is unchanged until the owner accepts proposal hunks.
5. Copy the technical app id from the browser URL. It starts with `plugin_asdk_app_`.
6. Replace `plugin_asdk_app_REPLACE_AFTER_CHATGPT_REGISTRATION` in `plugins/latex-workshop/.app.json` with that production app id. The id is deployment metadata, not a credential.

## 3. Import the workspace plugin

1. Push the repository revision containing `.agents/plugins/marketplace.json` and `plugins/latex-workshop` to GitHub.
2. In **Admin → Plugins**, choose **Add → Import marketplace** and enter the repository URL. Leave **Path** empty because the marketplace is rooted at the repository root.
3. Open the imported **LaTeX Workshop** plugin, enable its registered app, and set the installation policy to **Installed** for eligible roles. GitHub import does not apply repository policy values automatically.
4. Set authentication to occur on first use. Allow read and proposal actions without repeated confirmation; require confirmation for the immediate `create_project` and `rename_project` metadata actions.
5. On Enterprise/Edu, start with a pilot role. On Business, validate with workspace admins before enabling it for the workspace.

## 4. Acceptance check

Start a new ChatGPT web conversation after every app rescan or plugin sync. Run the cases in `plugins/latex-workshop/evals/golden-prompts.json` and record the selected tool, arguments, result, authorization behavior, and final link. Positive cases must call `list_projects` instead of producing a filesystem-access refusal; negative local-file and VS Code-extension cases must not activate the Mind Palace workflow.

After MCP tool metadata changes, refresh the app from ChatGPT Plugins. After skill or manifest changes, sync the GitHub marketplace and start another new conversation.

Official references: [connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), [MCP authentication](https://developers.openai.com/plugins/build/auth), and [workspace plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management).

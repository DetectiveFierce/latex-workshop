# Claude connector

Claude reaches LaTeX Workshop through the same OAuth-protected public MCP gateway that serves
hosted ChatGPT connections (see [Direct authenticated gateway](chatgpt-web.md#direct-authenticated-gateway-for-mind-palace)).
Claude calls connectors from Anthropic's cloud (`160.79.104.0/21`), never from a tailnet device,
so the private Tailscale `/api/mcp` URL and the retained OpenAI Secure MCP Tunnel do not work for
Claude. The Workshop website, login, and consent pages stay private; only the browser completing
sign-in needs Tailscale.

## Server requirements

The existing gateway already satisfies Claude's connector OAuth requirements; no Claude-specific
server mode exists. Keep these properties when changing auth or ingress:

| Claude requirement                                                         | Workshop behavior                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Protected resource `resource` equals the URL entered in Claude             | `AGENT_MCP_RESOURCE_URL` is the gateway `/api/mcp` URL            |
| First `authorization_servers` entry is reachable                           | Gateway forwards `/.well-known/*` and `/api/auth/oauth2/*`        |
| CIMD: `client_id_metadata_document_supported: true` and `none` auth method | `@better-auth/cimd`; public clients allowed                       |
| DCR fallback                                                               | `AGENT_MCP_DCR_ENABLED=true` on the gateway deployment            |
| PKCE `S256`                                                                | Only advertised method                                            |
| 401 + `WWW-Authenticate: Bearer resource_metadata=…` on protected calls    | `requireMcpAuth`; `initialize`/`tools/list` stay open (lazy auth) |
| 403 `insufficient_scope` with `scope` for step-up                          | Write tools without `proposals:write`                             |
| Rotating refresh tokens                                                    | 30 s reuse window, one-year retention by default                  |
| Redirect `https://claude.ai/api/mcp/auth_callback`                         | Supplied by Claude's CIMD/DCR registration                        |
| Claude Code loopback redirect on any port                                  | OAuth Provider strips loopback ports when matching                |

Check the live metadata from outside the tailnet before rollout:

```bash
curl -s https://workshop-mcp.tail7e24aa.ts.net/.well-known/oauth-protected-resource/latex-workshop/api/mcp
curl -s https://workshop-mcp.tail7e24aa.ts.net/.well-known/oauth-authorization-server/latex-workshop/api/auth \
  | jq '{client_id_metadata_document_supported, token_endpoint_auth_methods_supported, registration_endpoint}'
```

## Connect claude.ai, Desktop, and mobile

1. On a device signed in to the tailnet, open **Customize → Connectors** in Claude
   (<https://claude.ai/customize/connectors>) and choose **Add custom connector**.
2. Name it **LaTeX Workshop** and enter the remote connector URL shown under
   **Account settings → Agent access** (currently
   `https://workshop-mcp.tail7e24aa.ts.net/latex-workshop/api/mcp`). Leave the OAuth client ID and
   secret blank so Claude identifies itself with its Client ID Metadata Document.
3. Ask Claude to edit a LaTeX Workshop project. The first protected tool call shows a **Connect**
   card. Sign in to Workshop, choose the projects Claude may access, and approve.
4. Review the connection under **Account settings → Agent access**. Claude's web, Desktop, mobile,
   and Cowork surfaces share one connection; revoke it there at any time.

The connector syncs to every Claude surface on the account. Add the `latex-workshop-projects`
workflow as a Claude skill so Claude activates the Workshop tools on LaTeX requests; the server's
MCP instructions and `get_editing_guide` resource supply the same rules at runtime.

## Claude Code

The repository root is also a Claude Code plugin marketplace:

```bash
claude plugin marketplace add /path/to/latex-workshop   # or the GitHub repository
claude plugin install latex-workshop@mind-palace
```

The plugin bundles the skill and an HTTP MCP declaration for the gateway. Run `/mcp` once to sign
in; Claude Code uses its own CIMD and a loopback redirect, so it appears as a separate connection
under Agent access. On a tailnet machine, `claude mcp add --transport http latex-workshop <private
/api/mcp URL>` also works.

## Acceptance check

Run the cases in `plugins/latex-workshop/evals/golden-prompts.json` in a new Claude conversation
after connecting. Positive cases must call `list_projects`; local-file and VS Code-extension cases
must not activate Workshop. Claude caches discovery metadata for about five minutes, so allow that
long after changing scopes or discovery fields.

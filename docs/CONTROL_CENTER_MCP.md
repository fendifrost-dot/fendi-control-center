# Control Center MCP

Remote MCP server for ChatGPT (custom connector, Developer mode) and Claude.
It exposes the Muse workboard through the same read, write, and alert code as
`muse-executive`, `muse-workboard`, and `muse-alerts`.

The connector URL to paste:

```
https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/mcp
```

Authentication is OAuth 2.1 with PKCE (`S256`) and Dynamic Client Registration
(RFC 7591). There is no static bearer token to paste into the connector.

## What the connector can do

| Tool | Existing path |
|---|---|
| `read_workboard` | `muse-executive` resource `workboard` |
| `read_missions` | `muse-executive` resource `missions` |
| `read_posts` | `muse-executive` resource `work-feed` |
| `post_status` | `muse-workboard` `append_update` with `update_type` `STATUS` |
| `post_comment` | `muse-workboard` `append_update` with `update_type` `NOTE` |
| `post_report` | `muse-workboard` `record_daily_report` |
| `read_alerts` | `muse-alerts` open queue or cursor pull |
| `ack_alerts` | `muse-alerts` `ack` |

Posts and reports require `idempotency_key` (8–120 characters, `[A-Za-z0-9_.:-]`).
A status or comment also needs one parent id: `mission_id`, `task_id`, or `improvement_id`.

The board actor is taken from the OAuth client name: `ChatGPT` and `OpenAI` write as
`chatgpt`; `Claude` writes as `claude`. Alerts are matched with that same agent key.

`ack_alerts` uses the pull subscriber with that agent key. `chatgpt` is already
seeded. `claude` is inserted by
`supabase/migrations/20261117180000_muse_alert_claude_pull_subscriber.sql`
with alias `claude` and the audit role, the same shape as the chatgpt row.
It does not add the `Claude` alias, which belongs to `claude-code`.

## OAuth

| | |
|---|---|
| Protected resource | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/.well-known/oauth-protected-resource` |
| Authorization server | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/.well-known/oauth-authorization-server` |
| Issuer | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp` |
| Scope | `control_center` |
| Consent page | `https://fendi-control-center.lovable.app/oauth/mcp-authorize` |

The authorization server advertises `authorization_response_iss_parameter_supported: true`
and returns `iss` on every authorize redirect. OpenAI's connector docs (checked
2026-11-17) then use the stable callback
`https://chatgpt.com/connector_platform_oauth_redirect`. Servers that do not
advertise issuer identification use `https://chatgpt.com/connector/oauth/{callback_id}`.
Both are allowlisted, including the same paths on `chat.openai.com` and the older
`/aip/.../oauth/callback` plugin callback. `claude.ai` and `claude.com` (and their
subdomains) are allowlisted for Claude.

Only a user listed in `public.control_center_owners` can approve the consent page.
Client secrets and tokens are stored as SHA-256 hashes. Public clients
(`token_endpoint_auth_method=none`) do not receive a client secret. A confidential
client receives its secret once, in the registration response, and the raw value
is not stored.

## ChatGPT setup

1. Apply the migration and redeploy `control-center-mcp`, then Publish the
   frontend, using [`HANDOFF_CONTROL_CENTER_MCP.md`](HANDOFF_CONTROL_CENTER_MCP.md).
   The consent page is not live until Publish.
2. In ChatGPT on the web, turn on **Developer mode** for custom connectors.
   OpenAI's current guide (checked 2026-11-17) is **Plugins → + → Add custom MCP server**:
   https://developers.openai.com/api/docs/guides/custom-mcp-server
3. Name it `Control Center`. Paste the MCP URL above. Choose **OAuth**.
   Leave client id and client secret empty so ChatGPT registers itself.
   Do not paste a bearer token.
4. ChatGPT opens the consent page. Sign in as the Control Center owner and
   choose **Approve**.
5. In a chat, select the Control Center connector and ask it to read the workboard.

If registration fails with `invalid_redirect_uri`, copy the redirect URI shown
on the connector page. It should be one of the allowlisted callbacks above. A
new host is a code change, not a dashboard toggle.

## Claude

Add a custom connector with the same MCP URL and OAuth. Approve the same
consent page. Claude's callback host must be `claude.ai` or `claude.com`.

# Handoff — Control Center MCP

Make the remote MCP connector live. Code in this branch is not live until the
migration is applied, `control-center-mcp` is redeployed, and the frontend is
Published. Nothing below has been verified against the live project.

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ this handoff ships with the PR. Record the merge SHA here after it lands |
| Schema in the live database | ❌ `public.cc_mcp_oauth_clients`, `cc_mcp_oauth_codes`, and `cc_mcp_oauth_tokens` are not applied |
| Edge function `control-center-mcp` | ❌ not deployed |
| Frontend consent page | ❌ `/oauth/mcp-authorize` is not published |
| Validated locally | Deno tests for OAuth allowlist, PKCE, tool dispatch, secret scrubbing, and the migration's RLS. Not run against the live database |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ No supabase.com dashboard for migrations.
* ❌ Do not paste a static bearer token into ChatGPT or Claude.
* ❌ Do not edit `supabase/migrations/20261117120000_control_center_mcp_oauth.sql` to make it run. If it errors, paste the error back. That means the live database differs.
* ✅ SQL → Lovable SQL editor. Function → Lovable → Edge Functions → redeploy `control-center-mcp`. Frontend → Lovable → Publish.
* Publish is not the edge redeploy. Both are required. Redeploying `muse-executive` and `muse-workboard` is also required, because their handlers now call the shared read and write modules.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261117120000_control_center_mcp_oauth.sql` |
| Functions to redeploy | `control-center-mcp`, `muse-executive`, `muse-workboard` |
| Frontend | Publish, so `https://fendi-control-center.lovable.app/oauth/mcp-authorize` exists |
| Connector URL | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/mcp` |
| Setup notes | `docs/CONTROL_CENTER_MCP.md` |

No new secret is required. Owner approval uses the existing `control_center_owners` row. Optional overrides, only if the defaults are wrong: `CC_PUBLIC_APP_URL` (default `https://fendi-control-center.lovable.app`) and `CC_MCP_PUBLIC_URL` (default the function URL above, with no `/mcp` suffix).

## Step 1 — Apply the migration

Lovable SQL editor. Paste the full file `supabase/migrations/20261117120000_control_center_mcp_oauth.sql`. Run it once.

### Step 1a — Verify it landed

```sql
select c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('cc_mcp_oauth_clients', 'cc_mcp_oauth_codes', 'cc_mcp_oauth_tokens')
order by c.relname;
```

**Expected exactly:** 3 rows, each with `relrowsecurity = true`.

```sql
select count(*) as policies
from pg_policies
where schemaname = 'public'
  and tablename like 'cc_mcp_oauth_%'
  and 'authenticated' = any(roles);
```

**Expected exactly:** `policies = 0`. A number above 0 means a signed-in user can see OAuth hashes. Stop and report it. Do not add a policy for `anon` or `authenticated`.

```sql
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'cc_mcp_consume_oauth_code',
    'cc_mcp_rotate_oauth_refresh',
    'cc_mcp_oauth_cleanup_expired'
  )
order by proname;
```

**Expected exactly:** those 3 names.

## Step 2 — Redeploy the functions

Lovable → Edge Functions → redeploy, in this order:

1. `muse-executive`
2. `muse-workboard`
3. `control-center-mcp`

Do not Publish in this step.

### Step 2a — Deployed vs missing

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/control-center-mcp/health"
curl -s -o /dev/null -w '%{http_code}\n' "$B/control-center-mcp/mcp"
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-executive/executive/workboard"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/muse-workboard"
```

* `control-center-mcp/health` → `200`. `404` means the function is not deployed.
* `control-center-mcp/mcp` → `401`. `200` without a bearer is wrong. `404` means it is not deployed.
* `muse-executive` → `401` (still refusing anonymous reads).
* `muse-workboard` POST with no token → `401`.

The `401` from `/mcp` must include a `WWW-Authenticate` header whose `resource_metadata` is:

```
https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/.well-known/oauth-protected-resource
```

```bash
curl -s "$B/control-center-mcp/.well-known/oauth-authorization-server"
```

**Expected:** JSON with `"issuer"` equal to `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp`, `"authorization_response_iss_parameter_supported": true`, `"registration_endpoint"` ending in `/oauth/register`, and `"code_challenge_methods_supported": ["S256"]`.

## Step 3 — Publish the consent page

Lovable → Publish.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://fendi-control-center.lovable.app/oauth/mcp-authorize
```

* `200` → the SPA is published. The page is a client route, so a `200` from the host is the expected signal that the bundle is deployed. Then open the URL and confirm the heading is `Connect Control Center`.
* `404` → Publish did not include this route.

## Step 4 — Register the connector

Follow `docs/CONTROL_CENTER_MCP.md`. Paste this URL and choose OAuth, with no static bearer:

```
https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp/mcp
```

Approve the consent page while signed in as the Control Center owner.

For `ack_alerts`, register a pull subscriber whose `agent_key` is `chatgpt` (and `claude` if Claude will connect) through the existing `muse-alerts` `register_subscriber` action. That is the same registry the alert tools already use.

## Report back

1. The merge SHA.
2. The three SQL result sets from Step 1a.
3. The four HTTP status codes from Step 2a, plus the authorization-server `issuer` value.
4. The consent-page HTTP status, and whether the heading rendered.
5. Whether ChatGPT completed OAuth. Do not paste access tokens, refresh tokens, authorization codes, or client secrets.

## Do not

* Do not edit the migration to make it run.
* Do not grant `anon` or `authenticated` access to the OAuth tables.
* Do not mark this live from the fact that the code exists.
* Do not log or return tokens, client secrets, or the service-role key while verifying.

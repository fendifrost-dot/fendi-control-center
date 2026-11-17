# Handoff — control-center-mcp bundle

`control-center-mcp` failed to deploy because `_shared` imported
`muse-executive/contract.ts` and `muse-workboard/contract.ts`. Those contracts
now live in `_shared`, with thin re-exports left in the function folders.
This handoff makes that deploy and the Claude subscriber row live. Nothing
here has been checked against the live project.

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ this handoff ships with the PR. Record the merge SHA after it lands |
| `control-center-mcp` live | ❌ previous redeploy failed at bundling (`Module not found`) |
| `muse-executive` and `muse-workboard` | ✅ already redeployed before this fix. Do not redeploy them for this |
| Claude pull subscriber | ❌ `agent_key=claude` is not inserted yet |
| Validated locally | Deno import-graph test: every file reached from `control-center-mcp/index.ts` stays in that folder or `_shared`. Contract tests still pass through the re-exports |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ Do not edit the migration to make it run. If it errors, paste the error.
* ❌ Do not give the new row the alias `Claude`. That alias belongs to `claude-code`.
* ✅ SQL → Lovable SQL editor. Function → Lovable → Edge Functions → redeploy `control-center-mcp` only.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Migration | `supabase/migrations/20261117180000_muse_alert_claude_pull_subscriber.sql` |
| Function to redeploy | `control-center-mcp` |

## Step 1 — Apply the migration

Lovable SQL editor. Paste the full migration file. Run it once. Running it again is safe.

### Step 1a — Verify the row

```sql
select agent_key, roles, aliases, delivery, enabled
from public.muse_alert_subscribers
where agent_key in ('claude', 'chatgpt', 'claude-code')
order by agent_key;
```

**Expected exactly:**

| agent_key | roles | aliases | delivery | enabled |
|---|---|---|---|---|
| chatgpt | {audit} | {ChatGPT} | pull | true |
| claude | {audit} | {claude} | pull | true |
| claude-code | {coding} | {Claude,Cursor,claude-code,claude-code-cloud} | pull | true |

`claude.aliases` is `{claude}`. If it contains `Claude`, stop. That string belongs on `claude-code`.

## Step 2 — Redeploy `control-center-mcp`

Lovable → Edge Functions → redeploy **`control-center-mcp`**. Do not redeploy
`muse-executive` or `muse-workboard` for this. Do not Publish.

### Step 2a — Deployed vs still missing

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/control-center-mcp/health"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/control-center-mcp/mcp"
```

* health → `200`. `404` means the bundle did not deploy.
* POST `/mcp` with no bearer → `401`.

## Report back

1. The merge SHA.
2. The three subscriber rows from Step 1a.
3. The two HTTP status codes from Step 2a.

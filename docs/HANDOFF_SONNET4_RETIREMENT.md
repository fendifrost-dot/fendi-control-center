# Handoff — Claude Sonnet 4 retirement (`claude-sonnet-4-20250514` → `claude-sonnet-5-5`)

Anthropic retired `claude-sonnet-4-20250514` on 2026-06-15. Requests to it now fail with
`404 not_found_error`. On 2026-10-03, the `fendi_control_hub` API key sent 3 failed requests
to it. This repo had six edge functions that called it.

## Paste-ready prompt for the executing agent

Copy everything in the block below into a new Claude session that has browser tools signed in to Lovable (or the Lovable connector).

```text
You are executing a deploy handoff for the Fendi Control Center (CC) Lovable project.

Read these two files from github.com/fendifrost-dot/fendi-control-center on main first:
  1. CLAUDE.md (the chain-of-command rules)
  2. docs/HANDOFF_SONNET4_RETIREMENT.md (this handoff)
Then run Steps 1, 2, 2a and 3 of the handoff in order, and finish with the "Report back" section.

Context: commit 96fb217 moved six edge functions off the retired model
claude-sonnet-4-20250514 (which now returns 404) to claude-sonnet-5-5. The code is merged,
but none of it is live until the functions are redeployed in Lovable.

Lovable project id: 7fce9fc6-fd96-4a31-8a89-649f00298c51
Supabase (Lovable Cloud): wkzwcfmvnwolgrdpnygc

The steps:
  1. In Lovable Cloud -> Secrets, check ANTHROPIC_MODEL. If it holds claude-sonnet-4-20250514
     or any other dated claude-*-2025* ID, delete it or set it to claude-sonnet-5-5.
     Never echo a secret's value into chat. Report only which case applied.
  2. In Lovable -> Edge Functions, redeploy all six functions: ai-draft-treatment,
     ingest-tax-documents, import-prior-return, analyze-credit-strategy,
     generate-tax-documents, telegram-webhook. Record success or failure for each one.
  2a. Run the curl loop in the handoff. You need 200 or 204 for every function; 404 means
     redeploy that one again.
  3. Trigger one credit analysis, then run in the Lovable SQL editor:
       select model, created_at from credit_analyses order by created_at desc limit 1;
     Expected: model = claude-sonnet-5-5, with created_at after your redeploy.

Hard rules:
  - No supabase CLI and no supabase.com dashboard. A 403 there is a false wall, not a blocker.
  - Never ask Fendi for keys or ask Fendi to paste SQL.
  - Don't press Publish: there is no frontend change. Publish is not the same as redeploy.
  - Don't edit code or remove request parameters to make an error go away. Report any 4xx
    verbatim and stop.
  - Don't mark anything verified without pasting the real output. A claim of "done" is not
    evidence.
```

---

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ✅ `96fb217` |
| Schema change | — none needed |
| Edge functions live | ❌ **not redeployed**: still running the old code, so they still 404 |
| `ANTHROPIC_MODEL` secret | ❓ **unknown**: if it is set to the old ID, it overrides the new code default (see Step 1) |
| Validated locally | ⚠️ diff reviewed only. There is no Deno in the session that made the change, and no live call was made |

## What changed (code)

| File | Change |
|---|---|
| `supabase/functions/_shared/claude.ts` | Default model is now `claude-sonnet-5-5`. Added `output_config.effort: "low"` and server-side refusal fallback. **Response parsing now joins `text` blocks** instead of reading `content[0].text`: Sonnet 5.5 thinks by default, so `content[0]` can be a `thinking` block. Throws a clear error on `stop_reason: "refusal"`. |
| `supabase/functions/_shared/orchestrator.ts` | Model, effort and fallback, same as above. The parsing already looped over blocks. |
| `supabase/functions/ai-draft-treatment/index.ts` | Model, effort and fallback. The parsing already filtered on `type === "text"`. |
| `supabase/functions/ingest-tax-documents/index.ts` | Model, effort and fallback. |
| `supabase/functions/import-prior-return/index.ts` | Model, effort and fallback. **Also fixed** the PDF content block: it was sent as `type: 'image'` with `media_type: application/pdf`, which the API rejects. It is now `type: 'document'`. |
| `supabase/functions/analyze-credit-strategy/index.ts` | `credit_analyses.model` now records the model that actually ran, not the hard-coded retired ID. |

Why `effort: "low"`: Sonnet 4 ran without thinking. Sonnet 5.5 thinks by default (effort `high`), and that thinking counts against `max_tokens`. `claude.ts` has a 30 s timeout and `max_tokens` of 4096. Low effort is the closest match to the old behaviour and keeps calls within those limits.

What `fallbacks: "default"` does: it needs the `anthropic-beta: server-side-fallback-2026-07-01` header. If Sonnet 5.5's safety classifier declines a request, the API re-runs it on a fallback model inside the same call. It doesn't add cost on normal requests.

Not changed: the SQL migrations still use `DEFAULT 'claude-sonnet-4-20250514'` as a column default label on `credit_analyses`, `dispute_letters` and the tax tables. Those are text labels, not API calls, and the migrations are already applied, so they are left alone. Don't edit applied migrations.

## Hard rules

* ❌ Don't use the `supabase` CLI. A 403 there is a **false wall**.
* ❌ Don't use the supabase.com dashboard.
* ❌ Never ask Fendi for an API key in chat.
* ✅ Redeploy functions in **Lovable → Edge Functions → redeploy**. Secrets are in **Lovable Cloud → Secrets**.
* **Publish ≠ edge redeploy.** No frontend change here, so Publish isn't needed. Only redeploy.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase (Lovable Cloud) | `wkzwcfmvnwolgrdpnygc` |
| Repo | `fendifrost-dot/fendi-control-center` |
| Functions to redeploy (all 6) | `ai-draft-treatment`, `ingest-tax-documents`, `import-prior-return`, `analyze-credit-strategy`, `generate-tax-documents`, `telegram-webhook` |

`generate-tax-documents` and `telegram-webhook` didn't change themselves. They import
`_shared/claude.ts` or `_shared/orchestrator.ts`, so they keep the old code until they are redeployed.

---

## Step 1 — Check the `ANTHROPIC_MODEL` secret

In Lovable Cloud → Secrets, look for `ANTHROPIC_MODEL`.

* **Not present** → ✅ nothing to do. The code default `claude-sonnet-5-5` applies.
* **Present and equal to `claude-sonnet-4-20250514`** (or any `claude-*-2025*` ID) → ❌ this
  overrides the fix. Delete it, or set it to `claude-sonnet-5-5`.
* **Present with some other current ID** → leave it, and report which value it has.

Don't read the secret's value back into chat. Report only which of the three cases applies.

## Step 2 — Redeploy all 6 functions

Use Lovable → Edge Functions → redeploy for each name in the table above. Record a success or failure
for **each** one. "Redeployed them" isn't a report.

### Step 2a — Confirm each one is deployed

```bash
for f in ai-draft-treatment ingest-tax-documents import-prior-return analyze-credit-strategy generate-tax-documents telegram-webhook; do
  printf '%s ' "$f"; curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
    "https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/$f"
done
```

* `200`/`204` → deployed (CORS preflight answered).
* `404` → not deployed. Redo that function.

This only proves the function is deployed. It doesn't prove the new code is running. Step 3 checks that.

## Step 3 — Prove the new model is being called

Use the cheapest path: run one real credit analysis (for any existing test client) or one Telegram
orchestrator message. Then:

```sql
select model, created_at from credit_analyses order by created_at desc limit 1;
```

**Expected:** `model = claude-sonnet-5-5` (or the `ANTHROPIC_MODEL` value from Step 1), with a
`created_at` after the redeploy. If the newest row is older than the redeploy, the call failed. Check that
function's logs in Lovable for `Claude API error 4xx` and report the exact status and message.

* `400` mentioning `output_config`, `fallbacks` or the beta header → report it **verbatim**. Don't
  remove parameters until it works without saying what failed.
* `404 not_found_error` → the old model ID is still being sent. Go back to Step 1 and Step 2.

Final check: the Anthropic Console → Usage page should show `claude-sonnet-5-5` traffic on the
`fendi_control_hub` key, and Anthropic should send no more retirement-failure emails.

## Report back

1. Which Step 1 case applied.
2. The redeploy result for each of the 6 functions, plus the Step 2a HTTP codes.
3. The Step 3 query output: the actual `model` and `created_at`, pasted exactly.
4. Any 4xx text, verbatim.

Nothing in this file is verified yet. It is all `CODED`, not `LIVE`.

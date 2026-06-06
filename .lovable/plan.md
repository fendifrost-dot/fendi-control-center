# CC faceswap async refactor — file-by-file diff scope

Matches the new AVT contract: AVT submits, CC submits to Fal, Fal pings CC, CC relays to AVT's `faceswap-callback`. No more sync polling inside the 150s edge wall.

## Files touched (only these — no schemas, migrations, or unrelated routes)

1. `supabase/functions/faceswap-generate/index.ts` — rewrite (submit-only)
2. `supabase/functions/faceswap-generate-callback/index.ts` — **new** (Fal → AVT relay)
3. `supabase/config.toml` — add 2 blocks with `verify_jwt = false`

That's it.

---

## 1. `faceswap-generate/index.ts` — rewrite

**New request contract (matches what AVT sends):**
```json
POST /functions/v1/faceswap-generate
Header: X-Proxy-Secret: <COMPOSE_LOOK_PROXY_SECRET>
Body: {
  "mode": "submit",
  "callbackUrl":    "https://qoyxgnkvjukovkrvdaiq.supabase.co/functions/v1/faceswap-callback?job_id=<avt_provider_jobs.id>",
  "callbackSecret": "<shared with AVT faceswap-callback>",
  "faceImageUrl":   "...",
  "targetImageUrl": "...",
  "gender":         "male|female|non-binary",
  "workflowType":   "user_hair|target_hair",
  "upscale":        true
}
```

**Behaviour:**
- Validate `X-Proxy-Secret` against `COMPOSE_LOOK_PROXY_SECRET` (unchanged).
- Reject `mode !== "submit"` with 400 (room for future modes).
- Validate `callbackUrl` is a `https://qoyxgnkvjukovkrvdaiq.supabase.co/...` URL (defence-in-depth — we will only ever POST results to AVT).
- Build a signed token `t` = base64url(JSON{cb, cs, exp}) + "." + HMAC-SHA256(payload, COMPOSE_LOOK_PROXY_SECRET). `cb` = AVT callbackUrl, `cs` = callbackSecret, `exp` = now + 30 min. This is the only way CC will accept a Fal webhook call — Fal itself is unauthenticated, so the token in the URL is what authorises the relay.
- Construct Fal webhook URL:
  `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/faceswap-generate-callback?t=<token>`
- Submit to Fal queue:
  `POST https://queue.fal.run/easel-ai/advanced-face-swap?fal_webhook=<encoded webhook URL>`
  Body: same `{face_image_0, gender_0, target_image, workflow_type, upscale}` as today.
- Use a 10s `AbortController` timeout on the submit fetch (replaces `POLL_MAX_MS`). No polling loop at all — that whole block is deleted.
- Return `{ ok: true, providerJobId: <request_id> }` with 200. On Fal submit failure return the same `FAL_SUBMIT_FAILED` / `FAL_UNREACHABLE` shape as today so AVT keeps its existing error handling.

**Deleted from current file:** `POLL_INTERVAL_MS`, `POLL_MAX_MS`, the whole `while (Date.now() - started < POLL_MAX_MS)` loop, the `responseUrl` fetch, the image-extraction block. None of that runs in the sync path anymore.

## 2. `faceswap-generate-callback/index.ts` — new file

Receives Fal's webhook POST. Fal's webhook payload shape:
```json
{ "request_id": "...", "gateway_request_id": "...",
  "status": "OK" | "ERROR",
  "payload": { "image": { "url", "width", "height", "content_type" } },
  "error": "..." }
```

**Behaviour:**
- POST only. CORS preflight OK.
- Read `?t=<token>` from URL. Split on `.`, verify HMAC with `COMPOSE_LOOK_PROXY_SECRET`, check `exp`. Reject with 401 on any failure. (No reliance on Fal auth — we trust the URL because only we could have minted that signature.)
- Decode `cb` (AVT callback URL, already includes `?job_id=...`) and `cs` (AVT callbackSecret) from the token.
- Parse Fal body. Map:
  - Fal `status === "OK"` and `payload.image.url` present → `status: "succeeded"`, attach `fal_image_url`, `content_type`, `width`, `height`, `model: "easel-ai/advanced-face-swap"`, `provider_job_id: request_id`, `cost_cents: 5`.
  - Otherwise → `status: "failed"`, `error: <fal error or "no image in fal payload">`, plus `provider_job_id`.
- POST to AVT's `cb` with:
  - `Content-Type: application/json`
  - `X-Proxy-Secret: <cs>`
  - body above
- 10s timeout on the AVT POST. If AVT returns non-2xx, log to console (AVT callback is idempotent so Fal will retry the webhook on non-2xx from us, which re-triggers the relay). Return 200 to Fal on success, 502 on AVT failure so Fal retries.
- Return 200 to Fal once relay succeeds.

## 3. `supabase/config.toml` — append two blocks

```toml
[functions.faceswap-generate]
verify_jwt = false

[functions.faceswap-generate-callback]
verify_jwt = false
```

`faceswap-generate` is currently missing from config.toml — adding it explicitly closes that gap. `verify_jwt = false` is required for both: AVT calls `faceswap-generate` with `X-Proxy-Secret` (no JWT), and Fal calls the callback with neither.

---

## What I'm NOT changing
- No DB tables, no migrations, no RLS.
- No other edge function (compose-look, statement-external-callback, AVT functions).
- No frontend code.
- Secrets: reusing `COMPOSE_LOOK_PROXY_SECRET` (already shared with AVT) and `FAL_API_KEY` (already set). No new secrets needed.

## Deploy order after approval
1. Write the two function files + config.toml.
2. Deploy `faceswap-generate-callback` first (so the webhook URL is live before the next submit).
3. Deploy `faceswap-generate`.
4. Hand back to you to re-run Apply My Face end-to-end.

Approve and I ship.
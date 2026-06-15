# Cursor handoff (CC): face-fix skin-detail on the existing Fal pathway

## Why this is a CC handoff (not AVT)

Photorealism Phase 2 originally tried to add the Fal `face-fix` skin-detail
call **inside AVT's `faceswap-callback`**. That was wrong: the callback project
does not own a Fal key, and adding a Fal call there creates a **second,
independent Fal pathway**. We want exactly one place that talks to Fal.

That one place is **CC's `faceswap-generate`** — it already owns `FAL_API_KEY`,
already submits `easel-ai/advanced-face-swap`, and already polls Fal with the
shared `pollFalUntilDone` helper. Face-fix belongs there, right after the swap
result URL is obtained and **before** that URL is posted to the callback as
`fal_image_url`.

The in-Deno enhancements (eye catchlights + skin specularity) already shipped
in AVT `faceswap-callback` (commit `2bbdf26`) — they need no Fal call and stay
where they are. This handoff covers **only** the Fal `face-fix` step, on the CC
side.

```
AVT faceswap-proxy ──{mode:submit, callbackUrl?look_id=…}──▶ CC faceswap-generate
                                                              │ submit easel-ai/advanced-face-swap
                                                              │ pollFalUntilDone(...) → swapUrl
                                                              │ ★ NEW: callFalFaceFix(swapUrl) → fixedUrl
                                                              ▼
                         AVT faceswap-callback ◀──postCallback{fal_image_url: fixedUrl}──┘
                         (catchlights + specularity + film treatment, upload)
```

## Scope

- **Repo:** CC (`fendi-control-center` — this repo / the CC Supabase project).
- **File:** `supabase/functions/faceswap-generate/index.ts` (the function AVT's
  `faceswap-proxy` POSTs to — `ccComposeUrl.replace(/compose-look/, "faceswap-generate")`).
  > NOTE: this function is **deployed on the CC project but is not currently in
  > git**. Pull it first (`supabase functions download faceswap-generate`, or
  > copy the deployed source) so the edit is reviewable and committable. If it
  > truly only exists in Lovable, paste it into the repo before editing.
- **No schema changes.** Pure code addition.
- **Gate to the identity/look path only** — apply face-fix only when this
  request is the look pipeline (its `callbackUrl` carries `look_id=`). Leave the
  VLONE / `job_id` path's result byte-for-byte untouched, matching how the AVT
  catchlight/specularity stages are gated.
- **Single Fal pathway:** do NOT add Fal calls anywhere else. Reuse the existing
  `falKey` (`Deno.env.get("FAL_API_KEY")`) and `pollFalUntilDone`.

## Helper — match the existing submit-helper pattern

`faceswap-generate` should already have (or share with `compose-look`) the
`pollFalUntilDone(apiKey, requestId, statusUrl, responseUrl, timeoutMs)` helper
and the `FalImageResult = { request_id; image_url }` shape. Add a face-fix
helper in the same style as `callFalSeedreamEdit` / `callFalFluxLora`:

```ts
// Skin pore-detail restoration. Tries fal-ai/face-fix (purpose-built for
// portrait pore detail); falls back to fal-ai/clarity-upscaler at low strength;
// returns the original URL if both fail (graceful — never blocks a look).
//
// VERIFY the `fal-ai/face-fix` slug against the Fal catalog before deploy. If
// it isn't a live model, make clarity-upscaler the primary and drop the
// face-fix attempt — the fallback params below are already tuned conservative.
async function callFalFaceFix(apiKey: string, imageUrl: string): Promise<string> {
  try {
    const submitResp = await fetch("https://queue.fal.run/fal-ai/face-fix", {
      method: "POST",
      headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl,
        strength: 0.65, // detail restoration, not aggressive sharpening
      }),
    });
    if (!submitResp.ok) {
      throw new Error(`face-fix_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
    }
    const { request_id, status_url, response_url } = await submitResp.json();
    // face-fix is fast (~10–30s); 60s ceiling is plenty.
    const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 60_000);
    const url = result?.images?.[0]?.url ?? result?.image?.url;
    if (!url) throw new Error("face-fix_no_image");
    return url;
  } catch (err) {
    console.warn(`face-fix failed, trying clarity-upscaler: ${String(err)}`);
    try {
      const submitResp = await fetch("https://queue.fal.run/fal-ai/clarity-upscaler", {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: imageUrl,
          scale: 1,          // don't upscale, just enhance
          creativity: 0.15,  // low — restoration, not generative change
          resemblance: 0.85, // high — stay close to source
        }),
      });
      if (!submitResp.ok) {
        throw new Error(`clarity_submit_${submitResp.status}`);
      }
      const { request_id, status_url, response_url } = await submitResp.json();
      const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 60_000);
      return result?.images?.[0]?.url ?? imageUrl;
    } catch (err2) {
      console.error(`both face-fix and clarity-upscaler failed; using original: ${String(err2)}`);
      return imageUrl; // graceful degradation
    }
  }
}
```

## Wire-up

Find the point in `faceswap-generate` where the `advanced-face-swap` result URL
is obtained (after `pollFalUntilDone`, in the async/background task — the same
spot `compose-look` produces `falImageUrl` before `postCallback`). Insert one
gated call there:

```ts
// existing: swapUrl is the easel-ai/advanced-face-swap result
let outputUrl = swapUrl;

// NEW: skin pore-detail restoration, identity/look path only. Same Fal
// pathway and key as the swap; graceful fallback to the un-fixed swap.
if (isLookPath) { // e.g. callbackUrl.includes("look_id=")
  outputUrl = await callFalFaceFix(falKey, swapUrl);
}

// existing: post outputUrl to the callback as fal_image_url
await postCallback(callbackUrl, proxySecret, {
  status: "complete",
  fal_image_url: outputUrl, // <- was swapUrl
  // ...unchanged: pipeline_used, cost_cents, generation_metadata
});
```

Adjust `isLookPath` to however `faceswap-generate` already distinguishes the
look submit from the VLONE/`job_id` submit (inspect the `callbackUrl` query
string, or whatever field the proxy sends). The VLONE path must post `swapUrl`
unchanged.

If `faceswap-generate` instead returns the result synchronously (not via a
background `postCallback`), insert the same gated `callFalFaceFix` immediately
before that final result URL is returned — the rule is identical: face-fix the
look-path URL, leave the job-path URL alone.

## Cost / latency

- face-fix (or clarity-upscaler fallback): **+$0.02–0.04** per identity swap.
- Latency: **+10–30s** (Fal queue) on top of the existing swap, inside CC's
  existing background task — no change to the proxy's immediate `{ok}` response.

## Test plan

1. Deploy `faceswap-generate` on CC (CLI: `supabase functions deploy
   faceswap-generate`, or the CC project's normal deploy path). No change needed
   to AVT — `faceswap-callback` is already on `2bbdf26`.
2. Re-run Apply-my-identity on Pair 2 (`6880cd16-22bb-45ba-aada-14552ea56742`).
3. Expected v9 result:
   - Visible pore texture under face-zoom (face-fix) — clearly more than grain.
   - Catchlights in eyes + subtle specular highlights (already in AVT callback).
   - All v8 wins preserved (grain, warm gating, identity, outfit).
4. Confirm the VLONE / `job_id` path output is unchanged (no face-fix applied).

## Hard rules

- One Fal pathway only — face-fix goes in `faceswap-generate`, nowhere else.
- Reuse `FAL_API_KEY` + `pollFalUntilDone`; do not add a new key or helper copy.
- Gate to the look/identity path; VLONE / `job_id` path untouched.
- No schema changes. No edits to the AVT callback (it's already correct).
- Verify the `fal-ai/face-fix` model slug before deploy; fall back to
  clarity-upscaler as primary if it isn't live.

## Commit message

```
feat(cc): face-fix skin-detail on identity swap, in faceswap-generate

Adds callFalFaceFix() (fal-ai/face-fix → clarity-upscaler fallback) and runs
it on the easel-ai/advanced-face-swap result before posting fal_image_url to
the callback, identity/look path only. Reuses the existing FAL_API_KEY and
pollFalUntilDone — keeps all Fal calls on one pathway. VLONE / job_id path
unchanged. ~$0.02-0.04 and +10-30s per swap. No schema changes.

Pairs with AVT faceswap-callback 2bbdf26 (catchlights + specularity + film
treatment), completing photorealism phase 2.
```

# Kling O1 Edit Video-to-Video Smoke Test — Debugging Handoff

**Status:** RESOLVED (platform limit confirmed; workaround shipped). Sync mode cannot complete Kling O1 jobs — use `queue_only` or `callback_url` async mode instead.

**Cursor execution (2026-06-15):**
- Confirmed Fal endpoint `fal-ai/kling-video/o1/video-to-video/edit` exists; output schema is `{ video: { url } }`.
- Fixed bug: `pollFalUntilDone` was reading `finalResult.result` but Fal's `response_url` returns `{ video: { url } }` at top level.
- Added `queue_only` mode (mirrors `train-style-lora`) — submit returns `request_id` + poll URLs immediately.
- Refactored async mode to submit first, return `request_id` in `{ status: "queued" }`, poll in `waitUntil` background (600s).
- Added `scripts/kling-v2v-smoke.sh` — client-side polling bypasses Edge 150s IDLE_TIMEOUT.
- Extended `fal-queue-poll` to return `video_url` for Kling jobs.

**Run smoke test:**
```bash
export KLING_PROXY_SECRET="..."          # CC Edge Functions → Secrets
export COMPOSE_LOOK_PROXY_SECRET="..."   # for fal-queue-poll
export KLING_SOURCE_VIDEO_URL="https://...signed-720p.mp4"
./scripts/kling-v2v-smoke.sh 1           # prompts 1–4
```

Deploy: `supabase functions deploy kling-restyle fal-queue-poll`

---

**Status (original):** BLOCKED on Supabase Edge platform timeout limits. Need to either fix async handling or find alternative approach.

**Goal:** Test Kling O1 Edit (`fal-ai/kling-video/o1/video-to-video/edit`) for wardrobe + identity swap on Fendi's 5s performance clip (720×1280, 30fps).

---

## What We've Built

**Edge Function:** `/supabase/functions/kling-restyle/index.ts`
- Proxy pattern (matches switchx-restyle)
- Auth: `X-Proxy-Secret: iPhone22G!` header
- Input: `{sourceVideoUrl, prompt}`
- Calls Fal queue API directly, polls for completion, returns output URL

**Source Video:** 720×1280, 5s, 30fps
```
https://qoyxgnkvjukovkrvdaiq.supabase.co/storage/v1/object/sign/project-clips/777edf1e-9752-4b56-b3cc-92f1d63a6c9a/8d4a4d22-41c0-43ab-ba99-92750f81e335/restyle-smoke/fendi-test-slice-720-30fps-1781558562.mp4?token=[...]
```

**Test Prompts (4 wardrobe scenarios):**
1. Neon Tokyo alley + crimson silk shirt
2. Luxury private jet + black leather jacket + white shirt
3. Chicago rooftop sunset + denim trucker jacket
4. Capri villa + beige Pequin striped denim jacket + shorts + white tee

---

## Blocker: 150s Idle Timeout

**What happens:**
1. CC edge function submits job to Fal: `POST https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/edit`
2. Gets back request_id + status_url + response_url
3. Polls status_url every 3s waiting for COMPLETED status (which takes 60-180s)
4. **Supabase Edge terminates the connection after ~150s of "idle" polling**
5. Never see the completed response, never extract video URL

**Evidence:**
```json
{"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}
```

**Timeline:**
- Started with 540×960 source → rejected (Kling min 720px)
- Got 720×1280 source → jobs submit OK but all timeout before completion
- Increased sync timeout to 200s → no effect (platform ceiling is lower)

---

## Issues to Debug

### 1. **Polling is "idle" to the platform?**
Even though we're making fetch() calls every 3s to poll Fal's status, Supabase might count long-held connections as "idle" regardless of activity. Need to verify:
- Does polling actually reset the idle timer?
- Should we close/reopen the connection on each poll?
- Is there a different polling pattern that avoids the timeout?

### 2. **Fal response structure unknown**
We've never seen the completed response because jobs timeout before finishing. The extraction code tries:
```typescript
const outputUrl = final.result?.video?.url
  || final.result?.video_url
  || final.result?.output_video
  || final.result?.edited_video
  || (final.result as any)?.video?.url
  || (final.result as any)?.output?.url;
```
But we don't know if any of these are correct. **Need to see actual Fal response.**

### 3. **Is Kling O1 Edit even the right endpoint?**
We switched from `v2.1/master/video-to-video` (doesn't exist) to `o1/video-to-video/edit` based on research. Needs verification:
- Does `o1/video-to-video/edit` actually exist and work?
- What's the correct request body shape?
- What do successful responses look like?

---

## Possible Solutions

### A. Fix Async Mode (Recommended)
The edge function already supports async mode via `callback_url` parameter. Instead of waiting, we could:
1. Accept callback URL from client
2. Submit job, return request_id immediately
3. Background poll with longer timeout (600s available)
4. POST result back to callback URL when done

**Issue:** No callback URL configured for smoke tests. Would need to set up a temporary endpoint or manually poll Fal later.

### B. Extend the Timeout (Unlikely to Work)
Supabase Edge has hard limits. Increasing our function timeout won't override platform ceiling.

### C. Switch Back to SwitchX
SwitchX completed in <90s (no timeout issues) but:
- Can only do scene swaps in auto mode
- Custom mode (for wardrobe) needs alpha mask (extra build step)
- Fendi wanted to see if Kling could do wardrobe + identity in one call

### D. Find a Faster Video Editor
Look for alternatives that complete within 90-120s for a 5s clip.

---

## Debug Steps

1. **Verify the Kling endpoint exists**
   ```bash
   # Check Fal API schema (needs FAL_API_KEY)
   curl -H "Authorization: Key $FAL_API_KEY" \
     https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/edit/schema
   ```

2. **Get a successful Kling response to inspect**
   - Use FAL_API_KEY to submit a job directly (not via CC edge function)
   - Poll manually until completion (won't hit Edge timeout)
   - Log the full response JSON
   - Check where the output video URL lives

3. **Test async mode with manual callback**
   - Modify edge function to support `callback_url` param
   - Submit test with callback to a temporary ngrok/webhook endpoint
   - See if background polling works without timeout

4. **Check Supabase Edge docs**
   - Confirm idle timeout limit and whether it can be extended
   - See if there's a pattern for long-running async jobs

---

## Files to Check

- **Edge function:** `/supabase/functions/kling-restyle/index.ts`
- **Recent commits:** `84b7076`, `9f964c3`, `8ca42fe` (timeout/debug/endpoint fixes)
- **Test output:** Would be in `/tmp/test1_response.json` but never completed

---

## Key Contacts / Info

- **Fal Kling docs:** https://fal.ai/models/fal-ai/kling-video/o1/video-to-video/edit
- **Supabase Edge limits:** Check Supabase docs on function timeouts
- **Kling pricing:** $0.168/sec; 5s = $0.84/call

---

## Recommendation

Either:
1. **Debug why polling counts as "idle"** → might be a simple fix (keep-alive header, connection reuse, etc.)
2. **Set up async mode with callback** → slower feedback but avoids timeout completely
3. **Pivot to a faster alternative** if Kling O1 is fundamentally incompatible with Edge runtime limits

The core issue is **platform-level**, not code-level. We might be hitting an architectural limit rather than a bug.

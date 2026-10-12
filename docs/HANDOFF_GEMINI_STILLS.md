# Direct Gemini stills — verification-first handoff, 11 October 2026

## Validation run — 12 October 2026 (supersedes "untested" notes below)

Full results, spend and evidence: `fendifrost-dot/ai-video-tool` → `docs/handoffs/GEMINI_VALIDATION_2026-10-12.md`.

- LIVE and generating: 7 images, model access VERIFIED (`models.get` → "Nano Banana 2.1", version "3.0"). Fixes found by live evidence and shipped: #48 (dry-run probe + Google errors), #49 (**v1beta** — v1 404s for this model), #50 (**`imageConfig`** — `responseFormat.image` takes enums only), #51/#52 (memory).
- **BLOCKING:** 4 of 11 paid submissions were killed by `ERROR Memory limit exceeded` after Google answered (likely billed, image lost). With #52 the answer size is recorded: **11.3 MB** for a single 3.1 MB JPEG (`thoughtImageParts: 0`). HYPOTHESIS: a large `thoughtSignature` on the image part. Next fix: `responseFormat.image.delivery = "URI"` (enum form) or stream-parse the answer; verify ≥5 sequential runs with no crash. Until then: one request at a time, every attempt possibly billed.
- `maxOutputTokens: 4096` held: highest observed output was 3,415 (2,102 candidates + 1,313 thinking).

## Deploy status — updated 11 October 2026 (post-merge)

MERGED + EDGE-DEPLOYED. GENERATION NOT YET TESTED. Merged on the owner's explicit instruction ("merge commit"); the owner's instruction stands in for the Class C sign-offs below — no separate architecture/security review was recorded.

| Step | Evidence |
|--|--|
| CC PR #46 squash-merged | `03bf444213c1f9556d32cf555f9432293e6919f8` |
| AVT PR #231 squash-merged | `a14bc6ceabca172fa797fb59aafa66589d76061d` |
| SQL | **None needed — checked live**: AVT enum `provider_name` already contains `gemini`; all 10 `provider_jobs` columns the route uses exist; CC `tool_execution_logs` has no provider CHECK and has every column `startLog`/`finishLog` write |
| CC edge redeploy (Lovable) | `image-providers-gemini-generate` only, from `03bf444`. Secrets `Frost_Gemini`, `AVT_PROXY_KEY` present (yes/no only) |
| CC probe | unauthenticated POST `{}` → **401** `{"errorCode":"UNAUTHORISED"}` (control: unknown function → 404) |
| AVT edge redeploy (Lovable) | `world-still-proxy`, `avt-mcp`, from `a14bc6c`. Secrets `CONTROL_CENTER_URL`, `AVT_PROXY_KEY` present |
| AVT probe | unauthenticated POST → **401** platform `UNAUTHORIZED_NO_AUTH_HEADER` (verify_jwt = true; expected) |
| Free dry-run via AVT MCP | **200**, `ok:true`, `provider:"gemini"`, `dryRun:true`, `billed:false`, `credentialsConfigured:true`, `modelAccessVerified:false`, `referencesChecked:1`, `referencesSent:0` — every expected field matched |
| Frontend Publish | not needed, not done |

**Still NOT done:** (1) `scripts/qa/gemini_storage_rls.mjs` not run — needs two disposable identities; (2) no paid call yet, so Google model entitlement/billing on `Frost_Gemini` is unverified (`modelAccessVerified:false`); (3) no frontend model picker. Watch on the first paid call: `maxOutputTokens: 4096` includes thinking tokens at `thinkingLevel: "Medium"` — a `finishReason: MAX_TOKENS` with no image (`no_final_image`) would mean that budget is too tight; raise it in `contract.ts` (and `COST_BOUND_USD`) rather than retrying blindly.

## State (at PR time — superseded above)

CODED, NOT MERGED, NOT DEPLOYED, NO GENERATION. Implementation: `715fdd5521062dd1131db1e0f192cacdfc61964a` on `codex/gemini-stills`, based on `19930e4bc0fbc268381749dfe4b5f8df759a279a`.
Companion AVT implementation: `be9ee5cdfe89006d489e1d1c61884367cfdfd7c7` in `fendifrost-dot/ai-video-tool`, same branch name. Published through the authenticated GitHub connector; its implementation tree hashes match the locally tested trees exactly. This handoff commit only adds documentation.

The user asked to wire Nano Banana through Gemini/Control Center into AVT and correctly noted that Runway also offers it. Existing CC Gemini code handled OCR and Veo, not native still generation. Existing Runway generation code is video-only. Do not infer API funding from a web-app credit balance or tell the user to top up an unverified account.

## Exact route and scope

`AVT world-still-proxy` → `CC image-providers-gemini-generate` → Google `gemini-nano-banana-2.1:generateContent`.

- CC owns existing secret name `Frost_Gemini`. Its live presence, billing status and model entitlement are **not verified**. Do not ask for the key in chat.
- Shared `AVT_PROXY_KEY` authenticates the CC endpoint; no provider credential goes into AVT or the browser. This function is **not** added to the browser's generic CC allowlist.
- Google bills this route. It does not spend Higgsfield API dollars, Higgsfield web credits, Runway app credits, or Runway API credits.
- Model is pinned to `gemini-nano-banana-2.1`, one candidate per request, 1K/2K. Up to 14 references, subject to input-token and byte limits. Reference bytes are sent inline, not signed URLs, to Google.
- References must be AVT signed URLs on `qoyxgnkvjukovkrvdaiq.supabase.co`, from approved buckets under the authenticated caller's UID; project buckets must also match the project. Redirects, traversal, external hosts and arbitrary URLs fail before Google submission. AVT first resolves owned records and signs as the user.
- 8 MiB per image, 12 MiB combined reference bytes; no silent compression, resizing or dropping references. At most 16,384 counted input tokens and 4,096 output tokens (including thinking budget); cost gate uses a conservative **$0.147456 list-rate upper estimate per request**, not an invoice. The AVT reference-rate display rounds this to $0.1475. Use a $0.15 or greater explicit cap if a test is authorised. One 2K output image's published rate alone is $0.0504, but input/thinking costs are additional.
- Count tokens before generation. A count failure/unsupported count API stops with no generation. No automatic retry. Transport ambiguity after submission is possibly billed, never recorded as $0. Usage and provider-reported model version survive successful/no-image responses. Actual billed amount remains null.
- Audit must start before generation; image bytes and signed URLs are not logged. Outputs are returned to AVT, which stores pending, unselected project assets and finalises its job. No shot/variation is auto-selected.

## What was verified locally

- Clean `npm ci --ignore-scripts --no-audit --no-fund`, production build, app typecheck and full `npm test`: passed. The new edge tests are included in normal `npm test`, not hidden behind a separate command.
- New tests: **4 unit, 7 mocked integration, 0 provider-live, 0 real-media benchmark, 0 deployment smoke**. They test fixed routing/cost/input limits, owner URL scope, bytes/MIME, free dry-run, failed token counting, no paid retries, output extraction, usage and redaction.
- Edge entry bundled with esbuild (remote HTTPS imports external); local edge graph typechecked with ambient declarations for Deno/CDN imports. These are compile checks, **not a Deno runtime boot or live Google call**.
- No source dependency/lockfile change, no SQL migration, no provider key change, no production data mutation, no spend.

## Gates before merge/deploy

This is Class C (provider, money, private reference delivery). AVT's `CLAUDE.md` / `docs/ARCHITECTURE_REVIEW.md` require architecture, product and security sign-offs; none has been obtained for this change. Do not invent approvals or self-approve the three roles. The companion RLS test is also outstanding.

Review explicitly: list-rate bound vs actual bill; truncated output at the bounded token budget; countTokens support for this model; protected file ownership; byte/memory limits; Google-side timeout ambiguity; AVT job replay handling. Verify normal Grok routing remains unchanged and production wardrobe/performance work stays isolated.

## After the reviews: deploy through Lovable only

1. Re-fetch both repos and inspect active-agent handoffs. Merge the reviewed CC change and its AVT companion through normal PRs. Do not force-push unrelated branches.
2. CC Lovable project `7fce9fc6-fd96-4a31-8a89-649f00298c51`, backend `wkzwcfmvnwolgrdpnygc`: redeploy **only `image-providers-gemini-generate`** from the reviewed merge. No SQL and no frontend Publish required. Do not use Supabase CLI/dashboard.
3. Unauthenticated POST to `/functions/v1/image-providers-gemini-generate` with `{}` must yield **401 `UNAUTHORISED`**. 404 means missing deploy; 503/boot failure is not success. No generation occurs on this probe.
4. Through AVT's signed-in MCP, run the **dryRun body in the companion handoff** after AVT edge deployment. Expect `ok:true`, model `gemini-nano-banana-2.1`, `billingAccount:"Google Gemini API"`, `dryRun:true`, `billed:false`, `credentialsConfigured:true`, `modelAccessVerified:false`, `referencesSent:0`. Missing `Frost_Gemini` must surface a configuration failure, not a fallback.
5. Run `scripts/qa/gemini_storage_rls.mjs` in AVT against two existing disposable identities/objects. Positive own-file controls must pass; cross-owner and anonymous signing must fail. These credentials belong in the runner's secret environment, never chat. Existing RISK-001 is not fixed by this PR; a failure is a real blocker, not a reason to weaken the test.
6. **Paid reference submission is not authorised by this handoff.** A previous attempted portrait-upload test was blocked by automatic approval review; that is not permission to switch routes and retry it. First reconcile the user's current generation authorisation and reference-transfer scope. Any later authorised live test is one unselected still with a new Gemini job, no auto-retry; inspect the raw response, filed image and billing evidence. Do not change the approved rider/shot selections automatically.

## Primary sources checked 11 October 2026

- https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1 — stable ID, sizes and reference support.
- https://ai.google.dev/gemini-api/docs/generate-content/image-generation — documented v1 REST generateContent, `responseFormat.image`, reference inlineData and thought parts.
- https://ai.google.dev/api/tokens — documented v1beta countTokens endpoint.
- https://ai.google.dev/gemini-api/docs/pricing — input $1.50/M, text/thinking output $7.50/M, image output $30/M.
- https://docs.dev.runwayml.com/guides/models/ — Runway aliases `gemini_image3.1_flash` (Nano Banana 2), `gemini_image3_pro` (Pro), and legacy `gemini_2.5_flash`. They are not interchangeable endpoint/model IDs for the new Google route. No Runway API balance read was performed.

## Report back

PR/merge revisions; three review outcomes; exact redeployed function names; unauthenticated/dry-run/RLS results; whether key/model access was actually checked; any paid test's input IDs, request/model version, usage, invoice-unknown status and output ID. Do not call this live, funded or photoreal until the corresponding evidence exists.

---

## 12 Oct 2026, second pass: reliability fixes are live

Full evidence is in AVT [`docs/handoffs/GEMINI_RELIABILITY_2026-10-12.md`](https://github.com/fendifrost-dot/ai-video-tool/blob/main/docs/handoffs/GEMINI_RELIABILITY_2026-10-12.md).

| PR | Change | State |
|---|---|---|
| #55 | Streamed request body; incremental answer reader keeps only the final image (`thoughtSignature` counted, not kept) | deployed; live: 0 crashes in 6 submissions; peak heap ≤ 56 MB |
| #56 | Reference cap 14 MiB plus a 20,000,000-byte request guard (Google's inline limit) | deployed; live: 3 references / 13.4 MB OK |
| #57 | `maxOutputTokens` 8,192; per-request upper bound $0.270336 | deployed; one `MAX_TOKENS` run preceded it; the interim-image cause is a HYPOTHESIS |

**Verify the revision:** a real run's `response_payload_json` carries `requestBodyMode`, `largeFields` and `phases`. `costBasis` mentions `<=8192`.
Callers must pass `maxCostUsd ≥ 0.28`.

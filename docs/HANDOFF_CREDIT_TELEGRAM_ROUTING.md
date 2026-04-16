# Handoff: Credit / Telegram routing & execution (second review)

**Purpose:** Give another reviewer (e.g. ChatGPT or an engineer) enough context to validate architecture, edge cases, and deployment without re-reading the full thread.

**Repo:** `fendifrost-dot/fendi-control-center`  
**Relevant commits (approx. range):** `ac07107` (enhancements) → `df79c91` (routing hotfixes) — verify with `git log main`.

---

## What the user saw (symptom)

In Telegram, a message like:

- Add **Demeika Harris** to **Credit Guardian** (if not already),
- **Analyze** her credit via **Credit Compass**,
- **Create dispute letters** for multiple bureaus (Experian, TransUnion, Equifax, plus specialty names: LexisNexis, SageStream, Innovis, CoreLogic),

…produced a **Lane 2 assistant** reply claiming **no tools** and pointing to `/workflows`, instead of running **Lane 1** execution (`drive_ingest`, `credit_analysis_and_disputes`, `analyze_credit_strategy`, etc.).

---

## Architecture (short)

| Concept | Meaning |
|--------|---------|
| **Lane 1** | `executeAgenticLoop` with `allowTools: true` — real tool calls to Supabase Edge Functions / CG APIs. |
| **Lane 2** | Plain LLM reply — **no tools**; system prompt forbids simulating execution. |
| **Lane 3** | Autonomous / free-agent mode (separate triggers). |

Routing in `supabase/functions/telegram-webhook/index.ts` decides Lane 1 vs 2 **before** the assistant reply. If routing fails, users get Lane 2 and the model may **incorrectly** say it has no tools (even though the platform does).

---

## Root causes identified (bugs)

1. **Plural “dispute letters”**  
   `DISPUTE_LETTER_PATTERNS` used `\bdispute\s+letter\b`, which does **not** match the word **letters** as a whole token. So `inferCreditWorkflowKey` often missed the **credit_analysis_and_disputes** path for natural phrasing like “create dispute letters”.

2. **Credit Guardian phrasing**  
   Regexes assumed `to credit guardian` without optional **the** or **tool** (e.g. “to **the** credit guardian **tool**”). That broke `extractCreditGuardianClientNameForIngest` and weakened deterministic ingest routing.

3. **Broken grammar**  
   Messages like “Can you **Demeika Harris** to the credit guardian…” (missing **add**) did not match ingest patterns.

4. **Narrow “credit rescue”**  
   Lane 1 rescue only covered borderline confidence (~0.55–0.59). If auto-promote failed for other reasons, high-confidence credit intents could still fall through to Lane 2.

5. **Deployment gap**  
   **Lovable “Publish”** updates the app shell; **Supabase Edge Functions** (e.g. `telegram-webhook`) must be **deployed separately** (`supabase functions deploy` or Dashboard). Old bundles explain “still broken” after GitHub push alone.

---

## What was implemented (summary)

### Batch A — `ac07107` (enhancements)

- **`_shared/unifiedClientResolution.ts`:** Single resolver (CG list + `fuzzyClientSearch`) for name → client id; `analyze-credit-strategy` uses it; body accepts `cg_client_id` alias; success JSON may include `matched_display_name`.
- **Telegram:** Per-chat **credit client binding** in `bot_settings` (`session:<chatId>:credit_client_binding`); used for pronouns / short affirmations; persistence after successful `analyze_credit_strategy` JSON.
- **Telegram:** Richer **extractClientNameForCreditCommand** (`for` + credit cues, report for, etc.).
- **Telegram:** Lane 1 when no tool calls on credit workflows → **`execution_complete: false`** + user footnote (no fake “done”).
- **`generate-dispute-letters`:** Optional **Drive** `.txt` upload under client folder (`DRIVE_FOLDER_ID`); disable with `DISPUTE_LETTERS_UPLOAD_DRIVE=false`.
- **`creditDecisionEngine`:** Pronoun-led credit reference at **0.58** confidence; **`isCreditInformationalOnly`**.

### Batch B — `df79c91` (routing hotfixes)

- **Dispute patterns:** `\bdispute\s+letters?\b`, `\bcreate\s+dispute\s+letters?\b`.
- **CG extraction:** `CG_TARGET` = optional **the**, optional **tool**; patterns for “Can you add…”, “Can you NAME to…” (missing add).
- **Lane 1 rescue:** If not `no_credit_match`, confidence ≥ 0.55, and either borderline rescue **or** (confidence ≥ 0.6 **and** **executionCue** regex), run synthetic credit workflow instead of Lane 2.
- **Lane 2 addendum:** Do **not** claim no tools for Guardian/Compass when message is credit-related.

---

## Files a reviewer should read first

| File | Why |
|------|-----|
| `supabase/functions/telegram-webhook/index.ts` | Auto-promote, credit rescue, `executeAgenticLoop`, Lane 2 gate, binding helpers. |
| `supabase/functions/_shared/creditDecisionEngine.ts` | `inferCreditWorkflowKey`, ingest patterns, `isExplicitCreditGuardianIngestIntent`, `extractCreditGuardianClientNameForIngest`. |
| `supabase/functions/_shared/unifiedClientResolution.ts` | Canonical client resolution for analyze path. |
| `supabase/functions/analyze-credit-strategy/index.ts` | API contract (`client_id` / `cg_client_id`, `client_name`). |
| `supabase/functions/generate-dispute-letters/index.ts` | Dispute generation + optional Drive upload. |

---

## Open questions / risks (for second pair of eyes)

1. **Multi-intent single message**  
   User asks for **ingest + analyze + letters** in one paragraph. Current priority tends to **explicit CG → `drive_ingest`** first when patterns match; **full** dispute+letter pipeline may need a **second message** or a **composed workflow** — confirm product expectation.

2. **Specialty bureaus (LexisNexis, SageStream, Innovis, CoreLogic)**  
   Routing can land on **credit_analysis_and_disputes** / letter generation, but **FCRA templates and CG data** may still be **Big 3–centric**. Flag if product needs separate workflows or disclaimers.

3. **False positives on rescue**  
   Expanded rescue uses **executionCue** + confidence. Review whether casual “credit report” venting could still hit Lane 1 (mitigated by `isCreditInformationalOnly` and `no_credit_match`).

4. **Duplicate infer calls**  
   `inferCreditWorkflowKey` may be invoked multiple times per message — cost/latency vs clarity tradeoff.

5. **`isCreditInformationalOnly` false negatives**  
   Educational questions that look like execution might still route to Lane 1 — tune if users complain.

---

## Suggested verification checklist (after Supabase deploy)

1. Deploy **`telegram-webhook`** (and any changed functions) to the **same** Supabase project the bot uses.
2. **Ingest:** “Add **Test Client** to **the Credit Guardian tool**” → expect Lane 1 / ingest tool path, not Lane 2 refusal.
3. **Dispute plural:** “Create **dispute letters** for Experian for **Jane Doe**” → expect **credit_analysis_and_disputes** or analyze path, not “no tools.”
4. **Binding:** After a successful analysis, short “yes” / pronoun follow-up uses bound client where implemented.
5. **Logs:** Search for `credit_lane1_rescue`, `AUTO_PROMOTE`, `credit_guardian_routing` in function logs.

---

## Commands reference

```bash
# Typecheck locally
deno check supabase/functions/telegram-webhook/index.ts

# Deploy (example — confirm project ref)
supabase functions deploy telegram-webhook
```

---

## One-line summary for ChatGPT

*Telegram credit requests were falling through to Lane 2 because regexes missed “dispute letters” (plural) and “to the credit guardian tool” phrasing; ingest patterns failed on missing “add” and optional “the/tool”. Fixes are in `df79c91` on `main`, but **Supabase Edge Function deploy** is required for production; Lovable publish alone is insufficient.*

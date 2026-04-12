# Handoff: Credit Guardian name extraction → Tax Generator pattern

This doc explains what we fixed for **Credit Guardian** explicit ingest (`extractCreditGuardianClientNameForIngest`) and how to apply the **same engineering pattern** to **tax** Telegram parsing (`extractClientNameForTaxCommand` and related code in `taxTelegramParse.ts`), including in the `**taxgenerator`** repo if logic is duplicated there.

---

## 1. Problem we solved (Credit Guardian)

Operators sometimes phrase ingest like:

- `add Jabril dispute progress to credit guardian`

The **broad** regex used a greedy `NAME` segment between the action verb and `to/into/in … Credit Guardian`. That capture could include **status words** (`dispute progress`) that are **not** part of the client’s folder name, so Drive filtering targeted the wrong string.

A second issue: normalization used a filler-word list that included `**client`**, which stripped the word **Client** from legal names like **North Star Client LLC**.

---

## 2. What we implemented

### A. Post-capture noise strip

`**stripCgIngestNameNoise`** (private helper in `creditDecisionEngine.ts`) removes a trailing phrase **only at the end** of the captured substring:

-  `dispute progress` /  `credit progress` (case-insensitive)

So even if the main regex still captures `Jabril dispute progress`, normalization returns `**Jabril`**.

### B. Higher-priority pattern before the greedy `NAME` pattern

For the common case **single-token name + `dispute progress` + to CG**, we added a **specific** regex **before** the greedy pattern so the capture group is often just `**Jabril`** without relying on strip alone.

Order matters: **quoted names** → **dispute-progress single** → **greedy `NAME`** → other variants.

### C. Safer filler words

In `**normalizeExtractedCgClientName**`, we **removed** `client` from the `(the|a|an|my|our|client)` strip list so **LLC / business names** containing “Client” stay intact. Ingest patterns already use optional `(?:client\s+)?` before the name for “add client …” phrasing.

### D. Tests

`creditDecisionEngine_test.ts` includes cases such as:

- `add Jabril dispute progress to credit guardian` → `**Jabril`**
- `Add Mary Jane dispute progress to Credit Guardian` → `**Mary Jane**`
- `Add North Star Client LLC to Credit Guardian` → `**North Star Client LLC**` (full string)

Run:

```bash
deno test supabase/functions/_shared/creditDecisionEngine_test.ts --allow-env
```

### E. Git / deploy

- Changes live under `**supabase/functions/_shared/creditDecisionEngine.ts**` (imported by `**telegram-webhook**` and others).
- After changing shared code, **redeploy Edge Functions** that bundle it (at minimum `**telegram-webhook`**), via Lovable/Supabase as you usually do.

---

## 3. How this applies to Tax Generator

**Relevant Control Center code:** `supabase/functions/_shared/taxTelegramParse.ts`

- `**extractClientNameForTaxCommand`** — deterministic client name from tax-related Telegram commands.
- `**cleanup()**` inside that flow strips `tax`, `return`, `forms`, years, etc.

### Parallels


| Credit Guardian lesson                                                | Tax application                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greedy / broad capture eats **status filler** between name and anchor | Tax messages may insert **status words** (“extension”, “amendment”, “refund”, “progress”, …) between the name and anchors like `tax return` / `for 2022`. Add **targeted** strip-after-capture (and/or a **narrow** regex for the worst real phrase). |
| Don’t strip words that are **part of legal names**                    | Audit `**cleanup()`**: `\b(?:tax|return|forms?)\b` could theoretically hit substrings inside unusual business names. Prefer **suffix / context-aware** stripping or tests that lock acceptable behavior.                                              |
| Specific regex **before** greedy pattern                              | Add one high-priority pattern for the most common broken phrase once you see it in logs.                                                                                                                                                              |
| **Deno** regression tests                                             | Extend `**taxTelegramParse_test.ts`** with direct tests for `**extractClientNameForTaxCommand**` (multi-word LLC, “Client” in name, noisy phrasing).                                                                                                  |


### If `taxgenerator` is a separate repo

- Mirror the same **patterns** (strip helper + tests), or **share** one module if both deploy from a single source of truth later.
- Same **deploy rule**: any function importing changed `_shared` tax parse code must be **redeployed**.

---

## 4. Prompt you can give Claude

Copy-paste:

> Read `docs/HANDOFF_CREDIT_GUARDIAN_TO_TAX_PATTERN.md` in **fendi-control-center**. We fixed Credit Guardian client extraction with (1) `stripCgIngestNameNoise` after capture, (2) a high-priority regex before the greedy `NAME` pattern, (3) removing `client` from generic filler stripping so names like “North Star Client LLC” work, (4) Deno tests, (5) redeploy `telegram-webhook` after shared changes.
>
> Apply the **same engineering approach** to tax: `supabase/functions/_shared/taxTelegramParse.ts` — especially `extractClientNameForTaxCommand` and `cleanup()`. Add regression tests for LLC / noisy operator phrases; tighten stripping only when backed by examples. List which Edge Functions need redeploy after edits.

---

## 5. Key files (Credit Guardian)


| File                                                      | Role                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `supabase/functions/_shared/creditDecisionEngine.ts`      | `stripCgIngestNameNoise`, `normalizeExtractedCgClientName`, `extractCreditGuardianClientNameForIngest` |
| `supabase/functions/_shared/creditDecisionEngine_test.ts` | Unit tests                                                                                             |
| `supabase/functions/telegram-webhook/index.ts`            | Consumer of `extractCreditGuardianClientNameForIngest`                                                 |


---

*Last updated: aligns with the Credit Guardian ingest fix and `client` / LLC normalization on `main`.*
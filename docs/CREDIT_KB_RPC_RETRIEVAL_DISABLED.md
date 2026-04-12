# `CREDIT_RPC_RETRIEVAL_DISABLED`

> **Current state (2026-04-12):** `CREDIT_RPC_RETRIEVAL_DISABLED=1` is **active**.
> RPC retrieval is off; remote HTTP retrieval via `CREDIT_RETRIEVAL_URL` remains on.

## What it does

When set to **`1`** in Edge Function secrets, **all Supabase RPC usage of `match_credit_knowledge` for credit knowledge retrieval is skipped** in:

| Location | Behavior |
|----------|----------|
| `_shared/creditKnowledgeRetrieval.ts` | `retrieveKnowledgeFromRpc` returns empty buckets; `fetchKbViolationAnchorLine` returns `null` (no anchor RPC). |
| `credit-knowledge-retrieval` edge function | Returns a **structured JSON** response with empty `disputeExamples` / `analysisPatterns` / `violationLogic` plus `credit_kb_rpc_retrieval_disabled: true` (does not call OpenAI embeddings or `match_credit_knowledge`). |

Any other value (unset, `0`, `false`, etc.) leaves RPC retrieval **enabled** where implemented.

## What it does **not** do

- It does **not** disable **HTTP** KB retrieval: `retrieveRelevantKnowledge` in `_shared/retrieveRelevantKnowledge.ts` (`CREDIT_RETRIEVAL_URL`, `CREDIT_RETRIEVAL_INLINE_JSON`) is **unaffected**.
- It is **not** a global "turn off all credit features" switch — only **RPC-based** `match_credit_knowledge` paths listed above.

## Quick reference: retrieval paths

| Path | Secret that controls it | Disabled by `CREDIT_RPC_RETRIEVAL_DISABLED=1`? |
|------|------------------------|-----------------------------------------------|
| RPC (`match_credit_knowledge`) | `CREDIT_RPC_RETRIEVAL_DISABLED` | **Yes** |
| Remote HTTP | `CREDIT_RETRIEVAL_URL` | **No** — still active when URL is set |
| Inline JSON (dev-only) | `CREDIT_RETRIEVAL_INLINE_JSON` | **No** — independent; currently not set |

## Redeploy

After changing this secret, redeploy every Edge Function that bundles the shared module or hosts the standalone retriever, so the new value is picked up:

- `analyze-credit-strategy`
- `generate-dispute-letters`
- `credit-knowledge-retrieval`

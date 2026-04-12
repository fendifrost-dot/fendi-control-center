# `CREDIT_RPC_RETRIEVAL_DISABLED`

## What it does

When set to **`1`** in Edge Function secrets, **all Supabase RPC usage of `match_credit_knowledge` for credit knowledge retrieval is skipped** in:

| Location | Behavior |
|----------|----------|
| `_shared/creditKnowledgeRetrieval.ts` | `retrieveKnowledgeFromRpc` returns empty buckets; `fetchKbViolationAnchorLine` returns `null` (no anchor RPC). |
| `credit-knowledge-retrieval` edge function | Returns a **structured JSON** response with empty `disputeExamples` / `analysisPatterns` / `violationLogic` plus `credit_kb_rpc_retrieval_disabled: true` (does not call OpenAI embeddings or `match_credit_knowledge`). |

Any other value (unset, `0`, `false`, etc.) leaves RPC retrieval **enabled** where implemented.

## What it does **not** do

- It does **not** disable **HTTP** KB retrieval: `retrieveRelevantKnowledge` in `_shared/retrieveRelevantKnowledge.ts` (`CREDIT_RETRIEVAL_URL`, `CREDIT_RETRIEVAL_INLINE_JSON`) is **unaffected**.
- It is **not** a global “turn off all credit features” switch — only **RPC-based** `match_credit_knowledge` paths listed above.

## Redeploy

After changing this secret, redeploy every Edge Function that bundles the shared module or hosts the standalone retriever, so the new value is picked up:

- `analyze-credit-strategy`
- `generate-dispute-letters`
- `credit-knowledge-retrieval`

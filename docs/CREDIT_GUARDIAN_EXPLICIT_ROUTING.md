# Credit Guardian — explicit command routing

## Rule

If the message matches **both**:

1. **Target:** `credit guardian` **or** a standalone `cg` token, and  
2. **Action verb:** `add`, `put`, `onboard`, `register`, `sync`, `ingest`, `import`, `enroll`, `load`, `bring`

then it is treated as an **explicit Credit Guardian ingest** command. That path:

- Runs **before** tax routing, new/existing-client heuristics, Credit Compass, `query_credit_compass`, `analyze_credit_strategy`, NL workflow classification, and Lane 2 assistant mode.
- Does **not** use confidence thresholds to block execution (`shouldAutoExecuteCreditIntent` is always true for this case).
- Slash commands (`/do …`) still work as usual; natural-language explicit phrases do not require `/do`.

Implementation: `isExplicitCreditGuardianIngestIntent` and `inferCreditWorkflowKey` in `supabase/functions/_shared/creditDecisionEngine.ts`, and the auto-promote block in `supabase/functions/telegram-webhook/index.ts`.

## Deterministic ingest

When the workflow is `drive_ingest` **and** the explicit flag is set, the bot:

1. Extracts a client name with `extractCreditGuardianClientNameForIngest`, then falls back to `extractClientNameForDriveCommand`.
2. Resolves **aliases** with `resolveDriveIngestFilterKey` (`DRIVE_CLIENT_FOLDER_ALIASES_JSON`: map display name → Drive folder key).
3. Calls `ingest_drive_clients` **directly** with `{ client_name }` — no LLM tool selection when a name is present. If explicit intent is present but **no** name can be parsed, the bot returns a fixed clarification message (still Lane 1 execution, not generic chat).

## Alias resolution order

1. Exact / trimmed request string → lowercased key  
2. **Alias map** lookup on that key (`DRIVE_CLIENT_FOLDER_ALIASES_JSON`)  
3. Closest folder name **suggestions** use `suggestClosestDriveFolderNames` against sample folder names returned in ingest diagnostics when there are zero matches

## Structured failure (explicit ingest, zero matches)

If the tool returns `total_clients === 0`, the user gets a deterministic summary (not a generic LLM reply) listing:

- The **filter** used  
- **Hint** / diagnostics from the tool when present  
- **Similar folder names** from the response sample when available  
- Reminders to check Drive root env, dedicated-root flag, and aliases  

## Observability

Structured logs use `event: "credit_guardian_routing"` with fields such as:

- `message_text` / `message_preview`  
- `detected_explicit_credit_guardian_command`  
- `selected_workflow`, `routing_branch` (`deterministic_direct` vs heuristic)  
- `confidence_score` (still logged; not used to block explicit commands)  
- `client_name_extracted`, `used_alias_match`  
- `ingest_result_count`, `failure_reason` where applicable  
- `final_execution_mode` (`deterministic_direct`, `heuristic_auto`, `blocked`, etc.)

Task `result_json.credit_routing` may mirror these fields for auto-promoted runs.

# Agent Operating Rules

> Mandatory principles for the Fendi Control Center Telegram agent.
> Derived from: `supabase/functions/telegram-webhook/index.ts`
> Last updated: 2026-03-01

---

## Rule 1: No Tool, No Claim

If an action requires a tool call, the agent **MUST** either:

1. **Execute the tool** — and a `tool_execution_logs` row MUST exist with `status` = `attempted` → `succeeded` or `failed`, OR
2. **Return a hard error** explaining exactly what blocked execution.

**Violations:**
- Responding with "I will retry the job" without calling `retry_failed_job` is **forbidden**.
- Responding with "I'll check your documents" without calling `get_recent_documents` or `list_drive_files` is **forbidden**.

## Rule 2: No Log, No Execution

Every tool invocation MUST be preceded by a `logToolAttempt()` call that creates a `tool_execution_logs` row with `status='attempted'`.

- If `logToolAttempt()` fails, the tool execution MUST be **aborted** and the user MUST receive a `🚨 FATAL` error message.
- Silent tool executions (no log row) are **forbidden**.

## Rule 3: No Silent Failures

If any database query or external API call fails:

1. The error MUST be logged to `console.error`
2. The error MUST be surfaced to the user (either in the response or via an `errors[]` array)
3. Falling back to a default value (e.g., `0`) without reporting the error is **forbidden**

## Rule 4: Model Switching is Locked

The AI model CANNOT be switched unless the user **explicitly** requests it via:
- `/model grok` or `/model gemini`
- "switch to grok/gemini"
- "use grok/gemini"
- "change model to grok/gemini"

The guard function `isExplicitModelSwitchRequest()` validates this. If the AI attempts `switch_ai_model` without an explicit request, it receives: `🔒 Model switching is locked.`

## Rule 5: Destructive Actions Require Confirmation

Tools marked `destructive: true` MUST present inline Telegram buttons for user confirmation before execution:

| Tool | Destructive |
|------|------------|
| `retry_failed_job` | ✅ |
| `archive_job` | ✅ |
| `approve_document` | ✅ |
| `reject_document` | ✅ |
| `switch_ai_model` | ✅ |
| All read-only tools | ❌ |

The confirmation flow:
1. `storePendingAction(actionId, toolName, args)` → saves to `bot_settings`
2. Inline keyboard with ✅ Confirm / ❌ Cancel buttons
3. On confirm: `handleAgentConfirm(actionId)` → executes the tool
4. On cancel: `handleAgentCancel(actionId)` → deletes pending action

## Rule 6: No Workflow, No Action

If the user requests an action that does not correspond to any tool in `tool_registry.json` or workflow in `workflow_playbooks.json`, the agent MUST respond with exactly:

> **"No internal workflow exists for that request yet."**

And optionally offer to create one.

## Rule 7: Chat Scoping

- `getActiveModel(chatId)` checks chat-scoped session first (`session:{chatId}:active_model`), then global `ai_model`, then defaults to `"grok"`.
- Conversation turns are stored per chat ID (`conversation:{chatId}`) and limited to the last 20 turns.
- `tool_execution_logs` rows include `chat_id` for traceability.

## Rule 8: Request ID Correlation

Every inbound message generates a unique `requestId` (UUID). All tool executions within that message share the same `requestId` in `tool_execution_logs`, enabling:
- Correlation of multiple tool calls from a single user request
- Debugging of multi-step workflows
- Audit trail of what happened per message

## Rule 9: Evidence Over Claims

The agent must always provide **evidence** (actual data from database queries) rather than **claims** (invented or estimated values).

- Counts must come from `SELECT ... count: 'exact', head: true` queries
- File names must come from actual `documents` table rows
- Client names must come from actual `clients` table rows
- No hardcoded metrics, no placeholder values

## Rule 10: Authorized Chat Only

All messages from chat IDs other than the configured `TELEGRAM_CHAT_ID` are silently dropped. No error message is sent to unauthorized chats to avoid information leakage.

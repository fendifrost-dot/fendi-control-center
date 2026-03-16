# Telegram Webhook Bot — Forensic Report

## What the bot is supposed to do (and why each fails)

| Action | User input | Expected | Currently | Root cause (with line refs) |
|--------|------------|----------|-----------|-----------------------------|
| 1 | "run connected project stats" | Execute `get_project_stats`, return live stats | **YES** | Works: intent prefix "run " triggers auto-promotion (2271–2283), workflow matches, agentic loop runs with tools. |
| 2 | "find playlist opportunities for Meditate" | Call `find_playlist_opportunities` → `callFanFuelHub("playlist-research", { track_name: "Meditate" })` | **NO** (lane2_done) | **No auto-promotion:** Only prefixes `"run "`, `"execute "`, `"trigger "`, `"start "` set `hasExecutionIntent` (2271–2274). "find playlist opportunities..." doesn’t match → falls through to Lane 2 (2506–2613). |
| 3 | "/do find_playlist_opportunities" | Route to Lane 1, run `find_playlist_opportunities` | **NO** (stuck / no match) | **(1)** `_matchWorkflows(doArg, workflows)` matches only on `trigger_phrases` (35–48). If DB has phrases like `"find playlist opportunities"` (spaces) and user types `find_playlist_opportunities` (underscores), no match → `matches.length === 0`. **(2)** Misplaced block (2342–2375) lived inside the no-match branch and referenced undefined `workflowKey`/`params`/`userMessage`; real no-match update was buried. **(3)** Even when matched, FanFuel tools in `AGENT_TOOLS` had no `execute()` (1116–1136) and used `input_schema` instead of `parameters`; at 1579 `tool.execute(tc.args)` threw (undefined is not a function). |
| 4 | "approve document abc123" | Call `approve_document`, show confirmation, execute on confirm | **UNKNOWN** | Not traced; `approve_document` is implemented with `execute` and `destructive: true` (584–605). |
| 5 | "send a pitch to Peaceful Piano for Meditate" | `propose_plan` first, then on approval `send_playlist_pitch` → FanFuel | **UNKNOWN** | Not traced. |

---

## Forensic answers (with line numbers)

### 1. Action 2: Code path from message receipt to Lane 2

- **Message receipt:** Handled in the main webhook handler (request body → `text`).
- **Intent check (2271–2274):**  
  `EXECUTION_INTENT_PREFIXES = ["run ", "execute ", "trigger ", "start "]`  
  `hasExecutionIntent = EXECUTION_INTENT_PREFIXES.some(p => lowerText.startsWith(p))`  
  For `"find playlist opportunities for Meditate"`, `hasExecutionIntent` is **false**.
- **Auto-promotion (2276–2283):** Only runs when `hasExecutionIntent` is true and `_matchWorkflows(intentArg, …)` returns a chosen workflow. So `autoPromotedWorkflow` stays **undefined**.
- **Lane 1 /do (2315–2431):** `text.toLowerCase().startsWith("/do")` is false → skipped.
- **Lane 3 autonomous (2434–2493):** `AUTONOMOUS_TRIGGERS` don’t include this phrase → `isAutonomousRequest` false → skipped.
- **Lane 2 (2505–2613):** Default path. Task is updated with `progress_step: "lane2_start"` (2507), then assistant runs and finishes with `progress_step: "lane2_done"` (2613).

**Failing condition:** There was no trigger for “find playlist opportunities” in the intent-based auto-promotion, so the message never reached Lane 1.

### 2. Action 3: How `_matchWorkflows` matches; `/do find_playlist_opportunities`

- **Matching logic (35–48):** `_matchWorkflows` matched **only** on `trigger_phrases`. It did **not** match on workflow `key`.
- **Phrase check (40–44):** For each workflow, it loops over `wf.trigger_phrases` and checks `norm === np || norm.includes(np) || (norm.length >= 4 && np.includes(norm))` where `norm = _normalizeText(doArg)` (e.g. `"find_playlist_opportunities"`) and `np = _normalizeText(phrase)` (e.g. `"find playlist opportunities"`). String comparison is exact/substring; `"find_playlist_opportunities"` and `"find playlist opportunities"` differ (underscores vs spaces), so **no match** if the DB only has the phrase with spaces.
- **Result:** `matches.length === 0` → no-match branch runs. So `/do find_playlist_opportunities` was treated as “no executable workflow” and never ran the tool.

**Fix applied:** `_matchWorkflows` now also matches when the normalized input matches the workflow **key** (e.g. normalized input or its “key form” equals or contains the normalized key), so `"/do find_playlist_opportunities"` matches the workflow whose key is `find_playlist_opportunities` even if trigger_phrases use spaces.

### 3. executeAgenticLoop: Where tool.execute() is called; find_playlist_opportunities

- **Tool execution (1525–1591):** For each `tc` in `result.toolCalls`, the code gets `tool = AGENT_TOOLS.find(t => t.name === tc.name)` (1534). Then for non-destructive tools it runs `const output = await tool.execute(tc.args)` (1579).
- **find_playlist_opportunities in AGENT_TOOLS (originally 1116–1119):** The entry had only `name`, `description`, and `input_schema`. It had **no `parameters`** (required by `ToolDef`, 456–461) and **no `execute`**. So `tool.execute` was **undefined** → calling `tool.execute(tc.args)` threw.
- **Schema for AI:** `getGrokToolSchemas` / `getGeminiToolDeclarations` use `t.parameters` (1153, 1166). Those tools only had `input_schema`, so `t.parameters` was undefined when building schemas.

**Fix applied:** FanFuel tools (`find_playlist_opportunities`, `get_pitch_report`, `send_playlist_pitch`, `update_pitch_status`) now have `parameters` (replacing `input_schema`) and proper `execute()` implementations that call `callFanFuelHub` and return a string.

### 4. callFanFuelHub: URL, headers, env

- **Definition (2634–2653):**
  - **URL:** `Deno.env.get("FANFUEL_HUB_URL")` + `/functions/v1/${functionName}`. So for `callFanFuelHub("playlist-research", body)` it calls `https://<FANFUEL_HUB_URL>/functions/v1/playlist-research`.
  - **Headers:** `Content-Type: application/json`, `Authorization: Bearer ${key}`, `apikey: ${key}` where `key = Deno.env.get("FANFUEL_HUB_KEY")`.
  - **Env:** If `FANFUEL_HUB_URL` or `FANFUEL_HUB_KEY` is missing, it throws (2637–2638). So they must be set in the Supabase function env for the call to work.

### 5. Is playlist-research deployed on FanFuel Hub?

- The webhook only **calls** `https://<FANFUEL_HUB_URL>/functions/v1/playlist-research`. It does not define or deploy that function. If that edge function is not deployed on the FanFuel Hub Supabase project, the HTTP call will fail (e.g. 404); the webhook surfaces that via the thrown error and task failure. So **you need to ensure `playlist-research` is deployed** on the project that `FANFUEL_HUB_URL` points to.

---

## Three most impactful fixes (in order)

1. **Remove misplaced code and fix no-match branch (was 2339–2389)**  
   The block that referenced `workflowKey`, `params`, and `userMessage` lived inside `if (matches.length === 0)` where those variables don’t exist. That block was removed so the no-match branch only: sends the no-match message, updates the task to succeeded with `action: "do_no_match"`, sends “Done”, and returns. This prevents incorrect behavior and ensures `/do <unknown>` completes cleanly.

2. **Match workflows by key in _matchWorkflows (35–48)**  
   So that `/do find_playlist_opportunities` matches the workflow whose key is `find_playlist_opportunities` even when DB trigger_phrases use spaces (“find playlist opportunities”). Normalized input and normalized key (with spaces normalized to underscores) are now compared so that the workflow key is a valid match target.

3. **Add execute() and parameters to FanFuel AGENT_TOOLS (find_playlist_opportunities, get_pitch_report, send_playlist_pitch, update_pitch_status)**  
   So that when the agentic loop runs and the model returns a tool_use for these tools, `tool.execute(tc.args)` exists and calls `callFanFuelHub` with the right function and body, and schema builders get valid `parameters`. This fixes Lane 1 execution for these workflows and prevents runtime errors.

**Additional change:** Auto-promotion for “find playlist opportunities for X” was added so that phrase triggers intent-based Lane 1 execution (same block as “run …” / “execute …”), fixing Action 2.

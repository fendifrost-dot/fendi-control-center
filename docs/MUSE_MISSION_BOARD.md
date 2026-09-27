# Muse v2: mission board and daily improvement engine

This extends the [Muse v1 executive layer](./MUSE_EXECUTIVE_LAYER.md) into a structured work
system for Muse, Grok Bot, Claude and future specialist agents. It is not a chat board. Agents
coordinate through **state, ownership, evidence and measured outcomes**, and the database
enforces that state.

```
Fendi            owner: strategy, capital, legal, brand, irreversible or high-risk calls
 └ Muse          EXECUTIVE: proposes, selects, judges KEEP / REVISE / REVERSE / INCONCLUSIVE
    └ Grok Bot   CHIEF_OF_STAFF: assigns, coordinates, cancels, chases verification, closes
       └ Claude / Cursor / domain agents   SPECIALIST: execute assigned work, claim completion
          └ tools / APIs / systems
```

| | |
|---|---|
| Migration | `supabase/migrations/20260927120000_muse_mission_board.sql` (additive, idempotent) |
| Local proof | `scripts/muse/verify-muse-sql.sh`: v1 suite + `verify-muse-board-sql.sql` (60+ v2 assertions), all passing on PostgreSQL 16 |
| Live smoke | `scripts/muse/smoke-muse-board-live.sql` (rolls itself back) |
| Deploy | [`HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md`](./HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md) |

---

## First deliverable: inspection and design

### 1. What is reused

| v1 object | Reused as |
|---|---|
| `muse_improvements` | **The Daily Improvement row.** It already had baseline, problem, intervention (the proposed improvement), metric, `expected_result` (expected impact), `actual_result`, owner, review date, verdict and verification state. It is extended, not duplicated. |
| `muse_verifications` | **The Verification Queue.** It already had the CLAIMED → ARTIFACT → SYSTEM → LIVE ladder, claimant, verifier, repo/branch/commit and evidence URL. |
| `muse_systems` | **The agent registry.** Executors are foreign keys into it, so "claude-code" can't drift into "Claude" or "claude". |
| `muse_domains` | Portfolio spine for missions and improvements. |
| `muse_kpi_registry` / `muse_kpi_summary` | Live value for a mission's metric, and the "insufficient data" signal before an experiment starts. |
| `muse_open_loops`, `muse_decisions` | Unchanged. A specialist that spots a problem raises an **open loop**. It doesn't create an improvement. |
| `muse_executive_brief` | Blocked tasks, owner approvals and experiment reviews are routed into the **existing** sections, with no new vocabulary. |
| `muse_portfolio_map` | Gains rotation signals (last improvement, 30-day count, attention flag). |
| `muse-executive` edge function | Same function, same security model. Only the allowlist grew. |
| `MuseShell`, `MuseBits`, `museClient`, React Query | All new pages use them. There is no new app shell. |

### 2. What is extended

* **`muse_improvements`** gains 27 nullable or defaulted columns. They include `kind`
  (INTERVENTION/OBSERVE), `improvement_date`, `is_primary`, `function_area`, `observation`,
  `hypothesis`, `metric_key`, `confidence`, `risk`, `reversibility`, `priority`,
  `recommended_executor`, `selected_by/at`, `linked_mission_id`, `linked_experiment_id`,
  `definition_of_done`, `verification_requirement`, `owner_attention`, `approved_by/at`,
  `implemented_at`, `measurement_window_days`, `next_iteration`, `collision_override` and
  `created_by/updated_by`.
* **`muse_improvements.status`** is widened to the v2 lifecycle, and **`verdict`** gains `INCONCLUSIVE`.
* **`muse_verifications`** gains `required_state`, `artifact_ref`, `system_evidence`,
  `live_evidence`, `failure_reason` and `failed_at`.
* **`muse_systems`** gains `agent_tier`. It also gets two seeded rows, `muse` and `grok-bot`.

### 3. Schema delta

| New table | Purpose |
|---|---|
| `muse_missions` | Portfolio objectives: domain, title, objective, business outcome, owner, sponsor, priority, status, metric/metric_key, baseline, target, dates, dependencies, evidence, owner attention, created_by |
| `muse_improvement_tasks` | Agent queue: parent improvement, title, executor (FK), assigned_by, objective, instructions, expected artifact, DoD, priority, due, state, blocker, evidence, claimed completion, verification link |
| `muse_improvement_measurements` | Impact ledger: BASELINE / IMMEDIATE / D7 / D30 / OTHER, value, money, time saved, unintended consequences, evidence, data status. **Append-only.** |
| `muse_state_events` | History of every state change with actor and note. Written only by a `SECURITY DEFINER` trigger, so it is readable but not writable or erasable |

| New view | API resource |
|---|---|
| `muse_mission_board` | `/executive/missions` |
| `muse_agent_queue` | `/executive/agent-queue` |
| `muse_verification_queue` | `/executive/verification-queue` |
| `muse_impact_ledger` | `/executive/improvement-results` |
| `muse_improvement_ledger` (v1, columns appended) | `/executive/improvements` (daily = `?date=YYYY-MM-DD`) |

Legacy mapping: v1 `RUNNING`/`MEASURED` become `MEASURING`, and any row that already carries a
verdict becomes `DECIDED`. On live that affects one seeded row.

### 4. API delta

The same `muse-executive` function stays GET-only, with a closed allowlist, token auth, audit,
redaction and rate limiting. It adds four resources and eight new filters on `improvements`.
**There is no `daily-improvements` resource.** Daily is `improvements` filtered by date, which is
extension rather than duplication. There is still no write path in the read API.

```
GET /executive/improvements?date=2026-09-27&primary=true                 today's outcome
GET /executive/improvements?domain=boltz_automotive&metric=<norm>&active=true   collision check
GET /executive/improvements?awaiting_owner=true                          what needs Fendi
GET /executive/agent-queue?executor=claude-code&open=true                MY ASSIGNED TASKS
GET /executive/verification-queue?queue_state=PENDING
GET /executive/missions?status=ACTIVE
GET /executive/improvement-results?domain=boltz_automotive
```

`metric` matches `metric_norm`, which is the lower-cased `metric_key` or else the lower-cased
metric text. Filter values are restricted to `[A-Za-z0-9_.:\- ]`, so collision checks should use
a `metric_key` like `boltz.lead_to_appt`.

### 5. State machine (enforced by triggers, not convention)

**Improvement:**

```
INTERVENTION  PROPOSED ─▶ SELECTED ─▶ IN_EXECUTION ─▶ VERIFICATION ─▶ MEASURING ─▶ DECIDED ─▶ CLOSED
                 │  ▲         │            │     ◀── rework ──┘                  (KEEP|REVISE|
                 ▼  └─────────┘            ▼                                     REVERSE|INCONCLUSIVE)
              REJECTED ◀──────────────  REJECTED (open tasks must be cancelled first)
OBSERVE       PROPOSED ─▶ SELECTED ─▶ CLOSED        ("OBSERVE — NO CHANGE YET")
```

This maps onto the brief's chain as follows. APPROVED/SELECTED is `SELECTED` plus an optional
Fendi approval. ASSIGNED through BLOCKED are task states under `IN_EXECUTION`. IMPLEMENTED and
VERIFICATION are task states that roll up to the improvement's `VERIFICATION`. LIVE_VERIFIED is
the `verification_state` axis, and an improvement cannot enter `MEASURING` until it meets
`verification_requirement`. KEEP/REVISE/REVERSE is `DECIDED` with a verdict.

| Edge | Who | Precondition |
|---|---|---|
| → SELECTED | Fendi, Muse | risk, reversibility, confidence, recommended_executor, non-empty DoD, a window; **no live experiment on the same metric in the same domain** unless `collision_override` names a reason |
| → IN_EXECUTION | automatic on first task (or Grok) | if `owner_attention` ≥ APPROVAL: `approved_by = 'Fendi'` + `approved_at` |
| → VERIFICATION | automatic when the last task closes | every task COMPLETE/CANCELLED, ≥ 1 COMPLETE; the improvement inherits its **weakest** task verification |
| → MEASURING | Fendi, Muse, Grok | `verification_state` ≥ `verification_requirement`; stamps `implemented_at`, `review_at = implemented_at + window` |
| → DECIDED | **Fendi, Muse only** | verdict set; KEEP needs a post-baseline measurement with `data_status = KNOWN`; REVISE needs `next_iteration`; others need a measurement or `actual_result` |
| → CLOSED | Fendi, Muse, Grok | from DECIDED |

**Task:**

```
ASSIGNED ─▶ IN_PROGRESS ─▶ IMPLEMENTED ─▶ VERIFICATION ─▶ COMPLETE
   │  ▲ ▲       │  ▲            │  (claim opens a        │
   ▼  │ │       ▼  │            │   verification row)    │
 WAITING ⇄ BLOCKED              └──── failed / rework ◀──┘      any open state ─▶ CANCELLED (coordinator)
```

* The executor or a coordinator moves ASSIGNED, IN_PROGRESS, WAITING, BLOCKED and IMPLEMENTED.
  BLOCKED and WAITING require a `blocker`.
* **IMPLEMENTED** requires `claimed_completion` and automatically inserts a `muse_verifications`
  row (`CLAIMED`, `required_state` = task requirement).
* **VERIFICATION → COMPLETE** requires a verifier who is neither the executor nor the claimant.
  The verifier must meet the required level, and the verification must not have failed.
* COMPLETE and CANCELLED are immutable. Executor, assigner and parent are fixed: reassign by
  cancelling and re-assigning, which preserves history.

**Mission:** PROPOSED → ACTIVE → PAUSED / ACHIEVED / ABANDONED. Only Fendi or Muse can make
these moves.

The **write protocol** is the only way state moves. A bare `UPDATE … SET status` is refused.

| Function | Use |
|---|---|
| `muse_transition_improvement(id, to, actor, note, verdict?, actual_result?, next_iteration?, collision_override?)` | Improvement edges |
| `muse_transition_task(id, to, actor, note, blocker?, claimed_completion?, evidence?, cancelled_reason?)` | Task edges |
| `muse_transition_mission(id, to, actor, note)` | Mission edges |
| `muse_verify(verification_id, verifier, state?, evidence_url?, system_evidence?, live_evidence?, failure_reason?, note?)` | Promote (with evidence for the level) or fail a claim. Passing completes the task; failing sends it back to IN_PROGRESS |
| `INSERT` into `muse_improvements` / `muse_improvement_tasks` / `muse_missions` / `muse_improvement_measurements` | Creation. The insert triggers check the proposer, assigner or recorder |

These run as `SECURITY INVOKER`, so RLS still applies. They can be called by `authenticated` (the
signed-in operator) and `service_role` (edge functions). `anon` and `muse_reader` can't call them.

### 6. UI changes

`/muse` navigation now reads Brief · **Missions** · **Daily** · **Agent queue** ·
**Verification** · **Impact ledger** · Portfolio · Open loops · Sources · Systems. It uses the same
`MuseShell` and components, and the pages are read-only.

| Route | Surface |
|---|---|
| `/muse/missions` | Mission cards: metric, live KPI when registered, baseline → target, rollup of active/kept/reversed improvements |
| `/muse/daily` | Today's primary outcome (intervention card or OBSERVE), active experiments (protected metrics), portfolio rotation, lifecycle legend, last 14 days |
| `/muse/queue` | Tasks by executor, open/all toggle, claim/blocker/verification state |
| `/muse/verification` | Pending / failed / passed claims with required level and evidence |
| `/muse/improvements` | **Impact ledger** (baseline, immediate, 7-day, 30-day, delta, $, time, side effects, verdict), then the full improvement history. This replaces the old "1% ledger" tab rather than adding a duplicate |
| `/muse/portfolio` | Adds an "under-attended" badge |

### 7. Grok integration path

Grok Bot is registered as `grok-bot` (`CHIEF_OF_STAFF`). The daily loop:

1. **Read:** `GET /executive/improvements?status=SELECTED` and `?awaiting_owner=true`, plus
   `/executive/agent-queue?open=true` and `/executive/verification-queue?queue_state=PENDING`.
2. **Assign:** `INSERT INTO muse_improvement_tasks (… executor, assigned_by='grok-bot')`. The
   database refuses unapproved high-risk work, duplicates, and unselected parents.
3. **Coordinate:** `muse_transition_task(…, 'BLOCKED'|'WAITING', 'grok-bot', p_blocker => …)`;
   cancel with a reason.
4. **Verify:** `muse_verify(…, 'grok-bot', …)` with evidence. Grok may verify Claude's work but
   never its own.
5. **Start measuring and close:** `muse_transition_improvement(…, 'MEASURING' | 'CLOSED', 'grok-bot')`.

**Not wired yet (open question, recorded in `muse_systems.grok-bot.blocker`):** which runtime acts
as the Chief of Staff. Candidates are the Control Hub Telegram operator bot (`telegram-webhook`,
which runs Grok as a model), the Boltz Grok agent, or both. The recommended path is to add these
five calls as tools in the existing `telegram-webhook` tool registry, executing with the
service-role client. That keeps writes inside Control Hub's existing execution mechanism and out
of the read API. It needs a `telegram-webhook` redeploy, so it is deliberately a separate change.

### 8. Claude task-consumption path

1. `GET /executive/agent-queue?executor=claude-code&open=true` returns only Claude's work, with
   objective, instructions, expected artifact, DoD, due date and required verification.
2. Claude executes only what is assigned. Its tier (`SPECIALIST`) is refused by the database if
   it tries to create improvements, select, assign, cancel, decide, verify its own claim or
   complete its own task.
3. Claude reports through state: `IN_PROGRESS`, `BLOCKED` (with blocker), and `IMPLEMENTED` (with
   `claimed_completion` and evidence such as a PR or commit). That opens the verification
   automatically.
4. **Current gap:** a cloud Claude session has the read token but no write credential, so step 3
   runs through the operator or Grok until an executor write path exists. Recommended: a
   `report` scope on `muse_api_tokens`, consumed by a separate POST-only function limited to
   `muse_transition_task` for the token's own executor. That is a separate change, and the read
   API is never widened.

### 9. Verification flow

`IMPLEMENTED` opens a verification (`CLAIMED`, `required_state` inherited from the improvement,
default **`LIVE_VERIFIED`**). A verifier other than the claimant calls `muse_verify`:

* ARTIFACT_VERIFIED needs `evidence_url`, `commit_sha` or `artifact_ref`.
* SYSTEM_VERIFIED needs `system_evidence`.
* LIVE_VERIFIED needs `live_evidence`.
* A level below the requirement leaves the task in `VERIFICATION`. Meeting it completes the task.
* `p_failure_reason` marks the claim FAILED, which is permanent, and returns the task to
  `IN_PROGRESS`. The next claim opens a **new** verification, so history keeps both.
* A state never moves down.

### 10. Measurement flow

* `BASELINE` may be recorded at any time. `IMMEDIATE` requires `implemented_at`. `D7` and `D30`
  are **refused until 7 or 30 days after implementation**.
* Measurements are append-only. Only `data_status` and `notes` may change, so a number can be
  promoted to `KNOWN` once checked.
* The impact ledger computes delta against the baseline and sums money and time. It flags
  `d7_due` / `d30_due` and reads `NEEDS_VERIFICATION` until every post-change number is `KNOWN`.
* KEEP is refused without a KNOWN post-change measurement. The brief surfaces "Experiment review
  due" to Muse when `review_at` passes.

### 11. Collision and duplicate-work safeguards

| Risk | Safeguard |
|---|---|
| Same metric already has an active experiment | **Hard block** at SELECTED (domain + normalised metric), unless `collision_override` records why. The ledger shows `collision_count`/`collision_with` *before* proposing, and the API can query it |
| Recent change hasn't reached review | Covered by the above: it stays active through `MEASURING` until DECIDED |
| Another agent already owns the problem | `same_function_open_tasks` on the ledger row. The same task title cannot be open twice on an improvement (unique index) |
| Insufficient data | `metric_data_status` from the KPI registry on every row |
| Manufactured activity | One primary outcome per date (unique index). OBSERVE is a first-class outcome |
| Ignored domains | `attention_flag` on the portfolio. It stays `INSUFFICIENT_HISTORY` for the first 30 days of the board rather than inventing neglect |
| Owner attention | `owner_attention` defaults to NONE. HIGH risk or IRREVERSIBLE **cannot** be NONE or INFORM (CHECK). APPROVAL, DECISION and DIRECT_INVOLVEMENT block execution until `approved_by = 'Fendi'`. Fendi sees it in the brief only after Muse has selected it |

### 12. Migration risks

| Risk | Handling |
|---|---|
| **Re-running v1 after v2** fails with `cannot drop columns from view` | Documented in the v1 handoff and design doc. Re-run v2 instead, which is idempotent (validated by re-applying it in the harness). The failure is loud, not silent |
| Status and verdict CHECKs replaced on a live table | Dropped before the legacy mapping and re-added after. A live row with a verdict but no DECIDED status is mapped rather than violating |
| New triggers on `muse_improvements` / `muse_verifications` change v1 write behaviour | Status changes to improvements now need the transition function, since the v1 UI never wrote. Verification rows still accept direct updates, and history is added |
| **Actor is declared, not authenticated.** The operator or service role can pass any actor name | This is a stated limit. Tiers stop *honest* agents from overstepping and make every step attributable. They do not stop a compromised operator session. Per-agent credentials (see §8) close this |
| Lovable-generated `types.ts` doesn't know the new objects | As in v1: hand-written types in `src/lib/muse/types.ts` and an untyped client |
| `SECURITY DEFINER` history function | Pinned `search_path`, no caller input beyond the triggering row, `EXECUTE` revoked from PUBLIC/anon |
| Supabase default grants to `anon` on new functions | Explicitly revoked on the write protocol, triggers and helpers |

---

## What was deliberately not built

* **No chat or message board.** Coordination is rows and transitions.
* **No automation against production.** Nothing executes because a suggestion exists. Selection,
  assignment and execution are separate states.
* **No seeded business content.** The Boltz card from the brief is test data in the local harness
  only. Real missions and improvements are Muse's or Fendi's to record.
* **No write endpoint.** The read API is unchanged in kind. §7 and §8 name the write paths still
  to build.

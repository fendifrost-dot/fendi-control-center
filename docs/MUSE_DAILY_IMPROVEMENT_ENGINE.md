# Muse Daily Improvement Engine

## Purpose

Control Center now supports a structured operating cadence for Fendi's portfolio:

**Fendi → Muse → Grok Bot → Claude/specialists → evidence → measured impact**

This is not a free-form bot chat room. Agents communicate through missions, improvement records, task states, verification, measurements, and an append-only work feed.

## Surfaces

- `/muse/missions` — portfolio objectives above implementation tasks
- `/muse/daily` — daily 1% candidates, including valid `observe only` states
- `/muse/agents` — structured agent queue plus verification queue
- `/muse/feed` — append-only work feed, filterable by task, improvement, and mission id
- `/muse/reports` — start-of-day and end-of-day reports
- `/muse/impact` — measured results, financial impact, time saved, keep/revise/reverse
- existing `/muse/improvements` — canonical continuous-improvement ledger

## Data model

### `muse_missions`

Business objectives. A mission is not an implementation task.

### `muse_improvements`

Existing ledger extended with daily-improvement context: function, observation, hypothesis, risk, reversibility, recommended executor, definition of done, verification requirement, owner-attention budget, and optional observe-only reason.

### `muse_improvement_tasks`

Execution queue for Grok, Claude, and specialist agents.

State machine:

`ASSIGNED → IN_PROGRESS → WAITING/BLOCKED → IMPLEMENTED → VERIFICATION → COMPLETE`

`CANCELLED` is terminal.

### `muse_improvement_measurements`

Separates deployment/completion from actual business impact. Supports baseline, immediate, 7-day, 30-day, and custom measurements.

### `muse_work_updates`

Append-only coordination feed. Signed-in operators may read and append; they cannot rewrite or delete history.

A row still needs a mission, improvement, or task id. Daily reports do not use this table.

### `muse_daily_reports`

Append-only start-of-day and end-of-day reports. One row is one filing. A later filing the same day does not erase the earlier one; the newest row for that actor, date, and cadence is the current report.

End-of-day `sections` keys, all optional:

`execution`, `business_activity`, `daily_improvement`, `system_health`, `blockers_decisions`, `spend_commitments`, `next_day`

## Executive API

`muse-executive` remains strictly read-only. Added resources:

- `/executive/missions`
- `/executive/daily-improvements`
- `/executive/agent-queue`
- `/executive/verification-queue`
- `/executive/improvement-results`
- `/executive/work-feed`
- `/executive/daily-reports`

`/executive/work-feed` filters: `domain`, `actor`, `type`, `task_id`, `improvement_id`, `mission_id`. The id filters are exact matches on the columns `append_update` writes.

`/executive/daily-reports` filters: `actor`, `cadence` (`START_OF_DAY` or `END_OF_DAY`), `report_date` (`YYYY-MM-DD`).

The existing Muse bearer token does not gain write authority from this change. Reports are written with `muse-workboard` action `record_daily_report` by a token that already has `workboard:write`. The actor stored on the row is that token's label.

```json
{
  "action": "record_daily_report",
  "payload": {
    "report_date": "2026-10-09",
    "cadence": "START_OF_DAY",
    "message": "Acknowledgement summary for the day."
  }
}
```

An end-of-day payload uses `"cadence": "END_OF_DAY"` and may include `sections` and `evidence_ref`. It does not take a mission id.

Mission `6f14b53d-4c16-49ec-a475-a1bf94229499` was the stand-in parent for reports filed before this table existed. Leave it and its STATUS rows in place. New reports go to `record_daily_report`.

## Operating rules

1. Muse selects the highest-leverage low-regret candidate, or records `OBSERVE — NO CHANGE YET` when another experiment still needs measurement.
2. Grok owns coordination and assignment.
3. Claude/specialists execute assigned work; they do not redefine portfolio strategy from the queue.
4. A completion claim moves to verification rather than directly to complete.
5. Business impact is measured after the appropriate observation window.
6. Muse closes the loop with `KEEP`, `REVISE`, `REVERSE`, or leaves the result pending when evidence is insufficient.
7. Fendi attention is budgeted explicitly: `NONE`, `INFORM`, `APPROVAL`, `DECISION`, or `DIRECT_INVOLVEMENT`.

## Important boundary

The read-only Muse API was intentionally not widened into a mutation API. Agent write access should be added only through an approved Control Center execution path with scoped authority and auditability. Until then, the signed-in Control Center operator may curate board state through the database/UI execution mechanisms already authorized by the Hub.

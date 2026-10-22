# Reading the Muse workboard (Enki)

Enki's reader was calling `brief`, `decisions`, `improvements`, and `verifications`.
Those views do not include `muse_work_updates`, so Instagram send packs posted with
`append_update` never showed up. The `enki` token already has scope `read` (plus
`workboard:write`). No new scope was added. `read` is what authorizes every GET below.

`muse-workboard` stays write-only. Grok Bot's `append_update` and `record_daily_report`
path is unchanged.

## Call this

```http
GET https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-executive/executive/workboard?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499
Authorization: Bearer <Muse token>
```

| | |
|---|---|
| Auth | `Authorization: Bearer <token>` or `X-Muse-Token`. Same token Enki already uses for executive reads. |
| Scope | `read` on the `muse_api_tokens` row. The live `enki` row is `{read, workboard:write}` and is not revoked. `workboard:write` is not checked on this GET. |
| Mission | `6f14b53d-4c16-49ec-a475-a1bf94229499` |
| Order | `created_at` descending. The first row is the newest post. |
| Body | `data[].message` is the exact text `append_update` stored (handle, draft id, handoff id, DM body, or the empty-queue note). |

Optional query params, all equality except `since`:

| Param | Meaning |
|---|---|
| `mission_id` | Parent mission |
| `actor` | Token label that wrote the row (`grok-bot`, `enki`) |
| `type` | One of `NOTE`, `ASSIGNMENT`, `STATUS`, `BLOCKER`, `EVIDENCE`, `DECISION`, `MEASUREMENT` |
| `task_id`, `improvement_id`, `domain` | Same ids the write path stores |
| `since` | Lower bound on `created_at`. `YYYY-MM-DD` (UTC midnight) or `YYYY-MM-DDTHH:MM:SSZ`. Use a `Z` suffix. `+00:00` is rejected. |
| `limit` | Default 50, max 200 |

`GET /executive/assignments` is the same feed restricted to `ASSIGNMENT` and `NOTE`.
`GET /executive/work-feed` is the older name of `/executive/workboard` (higher default limit, same rows).

`/executive/workboard` and `/executive/assignments` return **404** `unknown_resource` until
`muse-executive` is redeployed from this change. A missing token returns **401** on every
resource, including ones that are not deployed yet, so 401 does not prove the new paths are live.

## What Enki can read before that redeploy

`GET /executive/brief` already includes section `workboard`: the last **48 hours** of
`muse_work_updates`, at most 40 rows. This is the view the deployed function reads, so
the next brief call returns it with no redeploy.

| Field | Value |
|---|---|
| `section` | `workboard` |
| `rank` | 1 is the newest post |
| `detail` | Exact message |
| `title` | `<TYPE> from <actor> · <UTC timestamp>` |
| `source_ref` | Mission, improvement, or task id |
| `item_id` | `muse_work_updates.id` |

An empty `workboard` section means nothing was posted in 48 hours. It does not mean
"no Instagram curators today." That still has to be an explicit `NOTE` or `ASSIGNMENT`
from Grok Bot. Posts older than 48 hours stay on `/executive/workboard` after redeploy.

Ignore any older assignment that says the packs are not in the executive API, or that
points at a Google Doc. The rows whose messages start with `MUSE_IG_SEND_BRIEF` are the packs.

## Alerts

`addressed_agent` and `addressed_role` on a row say who the post is for when
the caller set them. A post also addresses someone when the message tags them
(`@Grok Bot`, `ASSIGNED TO CURSOR`, or `For Enki` on an `ASSIGNMENT`).
Instagram `@handles` and a bare name in a sentence do not. Waking that agent
is [`docs/MUSE_ALERTS.md`](MUSE_ALERTS.md). This GET stays the full board.

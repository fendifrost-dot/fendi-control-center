# Handoff template

Copy to `docs/HANDOFF_<TOPIC>.md` and fill in. Delete guidance in _italics_ as you go.

The rule this serves is in [`CLAUDE.md`](../CLAUDE.md): when a coding session ends with steps
it could not execute, those steps get written up here and committed — never left in chat.

_Written for the executing agent, not for a human skimming. Assume it has repo access, a
terminal, and possibly browser tools, but **no memory of the session that produced the code**.
Everything it needs is either in this file or at a path this file names._

---

## Status going in

_A table, not prose. The point is that nobody has to guess where things stand._

| Thing | State |
|---|---|
| Code on `main` | ✅ merged in #NN (`<sha>`) |
| Schema in the live database | ❌ not applied — this handoff applies it |
| Edge function live | ❌ not redeployed |
| Frontend published | ❌ |
| Validated locally | ✅ how, and against what |

## Hard rules

_Restate the constraints that matter here, because an agent that hasn't read `CLAUDE.md`
will otherwise reach for the wrong tool and hit a false wall._

For anything Lovable-managed, that means at minimum:

* ❌ No `supabase` CLI — a 403 there is a **false wall**, not a real blocker.
* ❌ No supabase.com dashboard for migrations.
* ❌ Don't ask Fendi to paste SQL — the agent has the SQL, it runs it.
* ✅ SQL → **Lovable SQL editor**. Functions → **Lovable → Edge Functions → redeploy**.
  Frontend → **Lovable → Publish**.
* **Publish ≠ edge redeploy.** Separate buttons. Name which one you pressed.

## Coordinates

| | |
|---|---|
| Lovable project id | |
| Supabase project | |
| Repo | |
| Files to apply | _exact paths_ |
| Functions to redeploy | _exact names_ |

---

## Step 1 — _first action_

_Be specific enough to execute without interpretation: exact file, exact button, exact order._

### Step 1a — Verify it landed (never optional)

_A query or command with **exact expected output**, so a truncated paste or half-finished step
is caught instead of assumed successful. This is the difference between a handoff and a wish._

```sql
-- example shape
select count(*) as things from public.some_table;
```

**Expected exactly:** `things=N`. Anything lower means _<the specific failure mode>_ — redo
step 1.

## Step 2 — _next action_

_Include a cheap check that distinguishes outcomes rather than just "see if it works":_

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://.../functions/v1/<fn>
```

* `401` → ✅ deployed and correctly refusing unauthenticated reads.
* `404` → ❌ not deployed yet.

## Step N — Run the verification

```bash
node scripts/<area>/verify-<thing>-live.mjs
```

_Name what it proves. Then:_ **report its actual output.** Do not summarise as "passed" unless
it prints the success line.

## Final step — Record what is now true

_Only after verification passes. Writing this early defeats the point of having a ledger._

_If the project tracks verification state (`CLAIMED` → `ARTIFACT_VERIFIED` →
`SYSTEM_VERIFIED` → `LIVE_VERIFIED`), the promotion happens **here**, from real output —
never from the fact that code exists._

---

## Report back

1. Which buttons/commands you actually ran — name them.
2. The verification numbers from each check step.
3. Anything that came back unhealthy — that is a **finding about the live system**, not a
   deployment problem to work around.
4. The full output of the final verification.
5. Whether you completed the recording step.

## Do not

* Do not edit a validated migration or script to make it run. If it errors, report the error
  verbatim — it means the live environment differs from what was validated, and **that is the
  finding**.
* Do not hand-create objects the migration is supposed to create.
* Do not widen permissions to get past an error (no granting `anon`, no loosening a
  read-only surface).
* Do not mark anything verified that a live check did not prove.
* Do not "fix" rows that honestly report missing access — unreachable is accurate, and
  connecting them is usually a separate decision with its own trade-offs.

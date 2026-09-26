# CLAUDE.md — Fendi Control Center (CC)

Provider proxy / Fal / SwitchX / compose-look backend for AVT and related tools.

Repo: `fendifrost-dot/fendi-control-center`.

---

## CRITICAL — Chain of command (read every session)

**There is NO standalone Supabase.** This app is **Lovable-managed**. Do **not**:

- Run the `supabase` CLI (403 / wrong account = a **FALSE wall**)
- Open supabase.com dashboard to apply migrations
- Ask Fendi to paste/run SQL
- Hunt for a separate “Supabase project” outside Lovable Cloud

### Correct deploy / schema path

| Action | Where |
|--------|--------|
| Code + edge function source | GitHub `main` (this repo) |
| SQL / migrations | **Lovable SQL editor** on this Lovable project |
| Frontend live | Lovable **Publish** |
| Edge functions live | Lovable **Edge Functions → redeploy** |
| Secrets | Lovable Cloud — **never** ask for keys in chat |

**Publish ≠ edge redeploy.** Name which functions you redeployed.

### This project (CC)

| | |
|--|--|
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Local | `/Users/gocrazyglobal/Projects/fendi-control-center` |
| Supabase (Lovable Cloud) | `wkzwcfmvnwolgrdpnygc` |
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Holds | `FAL_KEY` (and related provider secrets) |

### Sister — AI Video Tool (SEPARATE)

| | |
|--|--|
| Repo | `github.com/fendifrost-dot/ai-video-tool` |
| Supabase | `qoyxgnkvjukovkrvdaiq` |
| Live | `aivideotool.lovable.app` |

AVT calls this CC via `switchx-restyle` / `fal-queue-poll` / `compose-look`. Do not put AVT wardrobe UI code in this repo. Do not put `FAL_KEY` on AVT.

---

## Finish every coding session with a handoff prompt

When you stop coding, anything you could **not** execute yourself gets written up as a
handoff prompt for the next Claude agent — committed alongside the code, not left in chat.

Chat scrollback is not a deliverable. If the work isn't finished, the repo has to say what
remains and how to verify it.

**Why this keeps happening:** the chain of command above. A cloud session usually has no
browser tools, so the Lovable SQL editor, **Edge Functions → redeploy** and **Publish** are
out of reach — but they are exactly the steps that make code live. Code merged to `main` is
`CODED`, never `LIVE`.

| | |
|--|--|
| Where | `docs/HANDOFF_<TOPIC>.md` |
| Template | [`docs/HANDOFF_TEMPLATE.md`](docs/HANDOFF_TEMPLATE.md) |
| Worked example | [`docs/HANDOFF_MUSE_LOVABLE_DEPLOY.md`](docs/HANDOFF_MUSE_LOVABLE_DEPLOY.md) |
| Commit it | With the code it belongs to, or immediately after |

A handoff must be **verification-first**, not a click list:

- What is done vs not done, with commit SHAs — no ambiguity about where things stand.
- **Exact expected values** (row counts, HTTP statuses) so a truncated paste or half-finished
  step is *caught*, not assumed successful.
- A cheap command that distinguishes outcomes — e.g. `401` (deployed, correctly refusing
  anonymous reads) vs `404` (not deployed).
- Guardrails: what **not** to do, especially "don't edit the migration to make it run" — a
  validated migration that errors means the live database differs, and that is the finding.
- What to report back.
- **Never** let the handoff mark anything verified. Verification happens after execution, from
  real output — an agent's claim of "done" is never completion.

If nothing remains, say so explicitly. Do not write an empty handoff to look thorough.

---

## Disk / workspace

- Code work: this repo only (or the repo the user named).
- Media: `/Volumes/T7/...` only — **never** iCloud `Mobile Documents` / MODEST paths (hydration fills the Mac).
- Keep `~/Library/Application Support/Claude/vm_bundles` — never delete.

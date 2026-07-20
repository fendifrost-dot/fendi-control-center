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

## Disk / workspace

- Code work: this repo only (or the repo the user named).
- Media: `/Volumes/T7/...` only — **never** iCloud `Mobile Documents` / MODEST paths (hydration fills the Mac).
- Keep `~/Library/Application Support/Claude/vm_bundles` — never delete.

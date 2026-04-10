# Fendi Control Center — Handoff & execution checklist

**Updated:** 2026-04-10  
**Repo:** [fendifrost-dot/fendi-control-center](https://github.com/fendifrost-dot/fendi-control-center)  
**Local clone:** `/Users/gocrazyglobal/fendi-control-center`

---

## Open this project in Cursor

**Option A — Control center only**  
File → Open Folder → `/Users/gocrazyglobal/fendi-control-center`

**Option B — Taxgenerator + control center together**  
File → Open Workspace from File… → open  
`/Users/gocrazyglobal/taxgenerator-main/fendi-stack.code-workspace`  
(two-root workspace: `taxgenerator-main` + sibling `fendi-control-center`)

---

## What changed locally (ready to commit)

`/tax status` in `supabase/functions/telegram-webhook/index.ts` was updated to match `/tax forms` behavior:

- Optional trailing **4-digit year** on the command is parsed; search uses **client name only** and `tax_returns.tax_year` is filtered when a year is given (fixes `ILIKE '%Sam Higgins 2022%'` never matching stored `Sam Higgins`).
- Success and no-results replies use **`parse_mode: undefined`** (plain text) so Telegram Markdown does not choke on names or dollar amounts (fixes silent hangs after `sendMessage`).

**Suggested commit message:**

```
fix(telegram-webhook): /tax status parses trailing year and sends plain text

- Strip optional 4-digit trailing year from /tax status nameArg (matches /tax forms)
- Apply .eq(tax_year, year) when a year is provided
- Send list/no-results with parse_mode undefined to avoid Markdown parse failures
```

**Deploy after push:** Lovable → ask to pull `main` and redeploy the **telegram-webhook** edge function only (or all functions if that is your usual flow).

---

## Verify in Telegram (@FendiAIbot)

1. `/tax status Sam Higgins 2022` → one row for 2022, plain text, under ~10s.  
2. `/tax status Sam Higgins` → all years for that client, no hang.  
3. `/tax Leon Dorsett 2024` → sanity check on a known return.  
4. `/tax forms Sam Higgins 2022` → should still list forms.

If anything still hangs, check Supabase edge logs for Telegram `sendMessage` errors.

---

## Sam Higgins multi-year (after deploy)

**Drive:** Chime statements were reported under `SAM 2025 TAXES` subfolders; **move** `Chime-Checking-Statement-*-2023.pdf` → `SAM 2023 TAXES` and `*-2024.pdf` → `SAM 2024 TAXES` before relying on year-scoped bank write-offs. Track missing Lyft 1099-K for 2023/2024 if applicable.

**Generation (wait for each `Done` before the next):**

```
/tax generate Sam Higgins 2022 with write-offs from bank statements in Drive
/tax generate Sam Higgins 2023 with write-offs from bank statements in Drive
/tax generate Sam Higgins 2024 with write-offs from bank statements in Drive
/tax generate Sam Higgins 2025 with write-offs from bank statements in Drive
```

Then `/tax status Sam Higgins <year>` and `/tax forms Sam Higgins <year>` per year.

---

## Related docs in this repo

- `COWORK_HANDOFF.md` — pipeline status, Supabase project id, key files, login notes (treat as sensitive).

---

## Security

- Prefer **SSH** or **credential helper** for GitHub; avoid embedding personal access tokens in `git remote` URLs. If a token was ever committed to a remote URL, **rotate** it in GitHub settings.

---

## Follow-up (optional)

- Broader fix: use `parse_mode: HTML` with escaping for dynamic `/tax *` replies, or log Telegram API errors in the outbox flush path.

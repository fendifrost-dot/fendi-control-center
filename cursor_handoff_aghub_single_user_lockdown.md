# Cursor handoff: Artist Growth Hub — strip multi-user auth, lock to single-tenant (Fendi only)

## Context

Artist Growth Hub (the app at `https://fan-growth-pilot.lovable.app/`, repo `fendifrost-dot/artistgrowthhub`, Supabase ref `vsemrziqxrrfcquxfnwd`) is an internal tool for Fendi only. Lovable's default scaffolding shipped it with multi-user auth — login flows, signup, account management, "Log out" — none of which should exist. Fendi explicitly: "there should be no logins and only one user which is me… no option to create another login create another user or create another account."

This handoff strips the multi-user surface from the code so:
- Root URL auto-signs anonymously (like AVT does now)
- No login / signup / account-create / forgot-password routes
- No "Log out" or "Switch Account" UI affordances
- No marketing landing page with "Sign in" / "Get started" buttons
- App shell is immediately visible to any visitor, working as if they're already authenticated

The schema-side single-tenant RLS lockdown is a SEPARATE step the orchestrator will drive via Chrome MCP + Lovable SQL Editor after this code lands. Don't bundle it.

## Repo + scope

- **Repo:** `fendifrost-dot/artistgrowthhub` (NOT the `fan-growth-pilot` misnaming we accidentally used in past briefs)
- **Push to `main` directly.** Single-dev repo, no PR workflow.
- **Use `gh` CLI auth** for the push — the PAT in `~/fendi-control-center/.git/config` is EXPIRED and `gh` is the working fallback (worked for AVT commits `1bc72d4` and `210fef2`).
- **No Lovable chat for code edits.** Lovable chat is only for `redeploy frontend from latest main and publish` after the push.
- **Frontend only this PR.** Schema lockdown (`single_tenant_all` RLS policies) is a separate step driven by Claude via Chrome MCP → Lovable SQL Editor. Don't write SQL migrations.

## Discovery — run these greps first

```bash
gh repo clone fendifrost-dot/artistgrowthhub /tmp/aghub
cd /tmp/aghub

# 1. Find every auth-related route and component
grep -rni "Login\|SignUp\|SignIn\|Register\|ForgotPassword\|ResetPassword\|CreateAccount\|Account.*settings\|auth/\|/login\|/signup\|/register" src/ --include='*.tsx' --include='*.ts'

# 2. Find auth UI surfaces in nav / header / sidebar
grep -rni "Log out\|Sign out\|Sign in\|Sign up\|Create account\|Get started\|Welcome back" src/ --include='*.tsx'

# 3. Find existing Supabase auth wiring
grep -rni "signInWithPassword\|signUp\|signInAnonymously\|signOut\|supabase.auth" src/

# 4. Find route config
grep -rni "Route path\|createBrowserRouter\|routeTree" src/

# 5. Find marketing landing components (if there's a public root different from app shell)
grep -rni "Hollywood\|Get Started\|Sign in\|hero" src/components src/pages src/routes 2>/dev/null
```

Capture the file paths before editing. The next sections describe WHAT to change; match exact patterns from your grep results.

## The changes

### Change 1 — Root route auto-signs anonymously

Find the top-level App component or root route (most likely `src/App.tsx` or `src/routes/__root.tsx`). Add `useEffect` that calls `supabase.auth.signInAnonymously()` on mount if no session exists:

```tsx
import { useEffect } from "react";
import { supabase } from "./lib/supabase"; // wherever the existing supabase client lives

// Inside the root component:
useEffect(() => {
  (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) console.error("Anon sign-in failed:", error);
    }
  })();
}, []);
```

If AVT's pattern is reusable, mirror that. Reference: AVT's working anon-sign-in lives in its root route (verified working at commit `796a1a1`).

### Change 2 — Remove login / signup / account routes from the router

For each auth route (login, signup, register, forgot-password, reset-password, account-create, account-management):

1. Remove the `<Route>` entry from the route config
2. Delete the corresponding page/component file (or stub it as a `<Navigate to="/" />`)
3. Remove any nav link / button that pointed to it

If TanStack Router with file-based routing, delete the route files under `src/routes/auth/*` (or wherever they live) and let the build regenerate the route tree.

### Change 3 — Strip auth UI affordances

Find every visible:
- "Log out" / "Sign out" menu item in profile / header
- "Sign in" / "Sign up" / "Get started" buttons
- "Forgot password" / "Reset password" links
- "Create account" / "Register" CTAs
- "Welcome back, [user]" personalization that implies multi-user

Replace them with either:
- Removed entirely (most cases — the menu becomes shorter)
- A simple "Settings" link if there's an existing settings page that's still relevant
- For "Welcome back" — replace with static "Welcome, Fendi" or remove

The profile menu currently has "My Account" and "Log out" per the orchestrator's earlier inspection. Both should be removed. If there's a settings surface that's still useful (theme, preferences), keep just that and rename to "Settings."

### Change 4 — Marketing landing (if present)

If there's a public-facing landing page at root (different from the app shell), replace it with the app shell directly. Don't gate the app behind a "Sign in to continue" page. The anon sign-in from Change 1 should fire immediately on root, and the app shell renders without any user-facing auth interaction.

If the marketing page has copy worth keeping (taglines, etc.), move them inside the app shell as informational content, not as gating.

### Change 5 — Defensive route guards

If any existing route is wrapped in a `<RequireAuth>` or similar component that redirects unauthenticated users to `/login`, change the redirect target to `/` (root, which now auto-anon-signs). Or remove the guard entirely since anon sign-in always succeeds.

### Change 6 — Hard-coded user identity (optional, only if needed)

If any component currently fetches the user's profile / display name / avatar and that fails without a "real" user, hard-code "Fendi Frost" / a default avatar / the artist ID. Don't break existing personalization, just make it work with anon sessions.

## What NOT to change

- **Don't touch the Supabase schema or RLS policies.** That's the orchestrator's separate step.
- **Don't remove the Supabase client setup, env vars, or edge function calls.** The app still needs the backend; just the user-management UI gets stripped.
- **Don't change the curator outreach / pitch-firing logic** if any exists in the codebase. The Track A workflow needs to keep working once auth is sane.
- **Don't add new dependencies.** Use what's already imported.

## Test plan after pushing

1. Push to `main` via `gh` CLI auth
2. In Lovable chat for the Artist Growth Hub project, EXACTLY:
   ```
   redeploy frontend from latest main and publish
   ```
   Wait for publish confirmation (~1-3 min for frontend builds)
3. Hard-refresh `https://fan-growth-pilot.lovable.app/` (Cmd+Shift+R)
4. Verify:
   - Root URL renders the app shell immediately, no "Sign in" / "Get Started" buttons
   - localStorage has `sb-vsemrziqxrrfcquxfnwd-auth-token` populated within 3 seconds (anon session established)
   - No console errors mentioning auth failures
   - No "Log out" or "My Account" menu items in profile / header
   - Navigating to `/login`, `/signup`, `/register`, `/auth` either 404s or redirects to root
   - Any settings-style surface that's still useful is reachable from the nav

## Hard rules

- **No Lovable chat for code edits.** Lovable chat is only for `redeploy frontend from latest main and publish` after this PR pushes.
- **No schema changes in this PR.** The single-tenant RLS lockdown is a separate orchestrator-driven step.
- **Push to `main` directly.** Single-dev repo, no PRs.
- **Use `gh` CLI auth** — the PAT in `.git/config` is expired.
- **Match existing code style.** No reformat passes.

## Commit message

```
chore(aghub): strip multi-user auth — single-tenant lockdown to Fendi only

Artist Growth Hub is an internal tool for one user (Fendi Frost). The
Lovable scaffold shipped with full multi-user auth (login, signup, account
management, log out) which isn't needed and surfaces friction. Removed:

- Login / Signup / Register / Forgot-password routes and pages
- "Log out" / "My Account" / "Sign in" / "Get started" UI affordances
- Marketing landing page (root now renders app shell directly)

Added:

- Anonymous sign-in on root mount (mirrors AVT pattern from commit 796a1a1)
- Hard-coded "Welcome, Fendi" where personalization was multi-user-aware

Supabase client setup, env vars, edge function call paths all unchanged.
Schema lockdown (single_tenant_all RLS policies) is a separate step driven
via Lovable SQL Editor.
```

## After this PR ships, orchestrator will:

1. Drive Chrome MCP to Lovable SQL Editor for the Artist Growth Hub project
2. Apply `single_tenant_all` RLS policies on every public-schema table (idempotent additive `CREATE POLICY ... FOR ALL TO authenticated USING (true) WITH CHECK (true)` — same pattern used for AVT)
3. Verify any previously isolated rows are now reachable from the anon session
4. Resume the stalled Track A 18-pitch batch using the now-clean anon JWT

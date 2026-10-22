# Mobile menu and Message Board publication

## Status going in

| Thing | State |
|---|---|
| Base inspected | `0d842c22a71f195aab9af094b04a51d3697e990c` on `main` |
| Implementation | `d12af36c0aed16736cc8905b350260df4c31aac3`, branch `fix/mobile-menu-message-board` |
| Local automated validation | 106 tests pass; TypeScript and Vite production build pass; ESLint exits 0 with 43 existing warnings, none in changed files |
| Browser/mobile layout verification | Not yet verified. Local Chromium cannot launch because the execution environment blocks its socket; the supported cloud browser cannot reach the workspace's localhost preview. |
| Frontend published | Not yet verified. A GitHub commit is CODED, not LIVE. |
| Database / edge functions / auth settings | Unchanged; no deployment or migration needed for this fix |

## Exact scope

- `src/components/hub/HubCoverNav.tsx`: constrain the sheet to `100dvh`; keep the header and close control outside a flex `min-h-0` scrolling region; include every tool and the final Operator ops link in that region; respect device safe areas.
- `src/lib/hubTools.ts`: add Message Board near the top, linking to `/muse/feed`. Keep the separate Agent Hub route `/agents`.
- `src/components/muse/MuseShell.tsx` and `src/pages/muse/MuseWorkFeedPage.tsx`: label the existing feed Message Board.
- Tests: five menu regressions and one Message Board title/feed regression.

The existing `useMuseWorkFeed` reads `muse_work_feed`, the full `muse_work_updates` view with no update-type restriction. Do not substitute the assignments-only `muse_workboard_assignments` view: that would hide STATUS acknowledgements and replies. Authentication, data fetching, and filters are unchanged.

## Hard rules and coordinates

- Repo: `fendifrost-dot/fendi-control-center`.
- Lovable project: https://lovable.dev/projects/7fce9fc6-fd96-4a31-8a89-649f00298c51
- Live app: https://fendi-control-center.lovable.app/
- Code changes go through GitHub only. Do not submit code through Lovable chat.
- Frontend publication is Lovable Publish. Do not redeploy edge functions, run SQL, use the Supabase CLI, change secrets, or change permissions for this frontend fix.
- Do not merge unrelated open PRs or deploy their backend work.

## Verify and publish

1. Confirm the fix PR is reviewed, its required checks succeed, and it is merged into `main`. Record the actual merge SHA. Do not infer merge/publication from branch existence.
2. In the Lovable project, confirm the preview has synced the merged code. Open the hamburger menu. Expected: Message Board appears directly after Agent Hub and points to `/muse/feed`.
3. Use the existing Publish/Update flow. Record the actual action and resulting published URL. If access or confirmation is required, report the exact blocker instead of claiming publication.
4. Open the live app and hard refresh. Verify at 320×568, 390×664 (reduced browser viewport), 390×844, 844×390 landscape, and desktop 1440×900 where supported:
   - All ten tool rows are present; Message Board is near the top.
   - The menu fits the visible viewport, and scrolling reaches both Remote Mac and Operator ops footer links.
   - The header/close control remain accessible; background page does not scroll with the list.
   - Bottom content remains above the iPhone home indicator; rotate and repeat.
   - Closing and reopening works. Clicking a link closes the drawer.
   - Message Board opens `/muse/feed`. Signed-out access still requests sign-in; after normal authorized login, the heading is Message Board and full feed types (including STATUS/NOTE) remain visible.
   - Desktop menu, Agent Hub, external product links, and footer navigation still work.

## Report back

Record the actual PR URL, merge SHA, publication result, live URL, tested viewports/device, and any failing checks. Add screenshots of the menu top/bottom when possible. Do not mark mobile Safari, authenticated feed content, or LIVE verified unless the corresponding real check ran.

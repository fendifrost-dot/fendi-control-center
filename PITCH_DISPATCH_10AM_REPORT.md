# 10am Dispatch Report — Designed For Me (Control)

**Ran at:** 2026-06-01T15:01:59Z

## Summary
- Total approved drafts in queue: 6
- Skipped by safety filter: 6 (details below)
- Attempted send: 0
- Successful sends: 0
- Failed sends: 0

No drafts passed the safety filter, so no sends were attempted. All approved drafts in the queue are stale test rows (mail-tester recipients), an Instagram DM, and/or tied to inactive playlist targets.

## Skipped drafts
- draft_id=68c7d264-a5dc-4059-ae85-9758b6b56495 | recipient=test-dfu3weend@srv1.mail-tester.com | generated_by=mt-rr3 | reason=rule4 (recipient contains "mail-tester"/"@srv"/"test-"); rule5 (generated_by starts with "mt-")
- draft_id=73f18be1-28c7-4a5e-abe8-ae81b495dc48 | recipient=test-dfu3weend@srv1.mail-tester.com | generated_by=mail-tester-rerun-replyto-2 | reason=rule4 (recipient contains "mail-tester"/"@srv"/"test-"); rule5 (generated_by contains "mail-tester")
- draft_id=e6e2e492-935b-4102-abf6-c2d897df2cb7 | recipient=test-dfu3weend@srv1.mail-tester.com | generated_by=mail-tester-rerun-replyto | reason=rule4 (recipient contains "mail-tester"/"@srv"/"test-"); rule5 (generated_by contains "mail-tester")
- draft_id=dcfd0833-6fef-4fea-81cb-9b3c8ff701d0 | recipient=test-dfu3weend@srv1.mail-tester.com | generated_by=mail-tester-rerun-replyto | reason=rule4 (recipient contains "mail-tester"/"@srv"/"test-"); rule5 (generated_by contains "mail-tester"); rule6 (playlist_id spotify:7C08E6SOsHv3hAL2ulZP3p not in active targets)
- draft_id=8a2e1c2b-7f27-41ad-97e0-036a0971125c | recipient=test-4ob3hn50o@srv1.mail-tester.com | generated_by=mail-tester-run | reason=rule4 (recipient contains "mail-tester"/"@srv"/"test-"); rule5 (generated_by contains "mail-tester"); rule6 (playlist_id spotify:7C08E6SOsHv3hAL2ulZP3p not in active targets)
- draft_id=cd77ef71-2dfe-4c7c-8061-53b011ae1c1e | recipient=uoakmusic | generated_by=auto | reason=rule2 (channel=instagram_dm); rule3 (recipient not a valid email); rule6 (playlist_id spotify:57rLc4B0AUS2yKNwP9IMUr not in active targets)

## Successful sends
- None

## Failed sends
- None

## Aggregate pitch stats for this track
```json
{
  "track_name": "Designed For Me (Control)",
  "totals": {
    "sent": 4,
    "replied": 0,
    "placed": 0,
    "errored": 0,
    "pending": 4,
    "sent_last_24h": 1,
    "sent_last_7d": 4,
    "reply_rate_pct": 0,
    "placement_rate_pct": 0
  }
}
```

## Notes
- 30 active playlist targets were retrieved for segment `deep_house_groove`; none of the skipped drafts' playlist_ids that mattered changed the outcome, since each skipped draft already failed on recipient/channel/generated_by grounds.
- No writes were made to playlist_targets or tracker rows. No test_mode sends. batch_override_cap was never exercised because nothing was sendable.

# Agent Hub capability check — result: NO (no already-authorized identity available)

Nothing was sent, written, minted, or configured.

## How agent-hub accepts create_thread / handoff
- Fendi: signed-in session JWT whose user is in `control_center_owners` (actor "fendi").
- Agents: Muse API token with scope `agenthub` or `workboard:write`, whose label maps to a row in `agent_hub_agents.token_label`.
- `agenthub:ingest` tokens may only call `ingest`; the bridge token may only report capabilities/results.
- The service-role key is explicitly rejected.

## What this workspace has
- Browser auth status: `signed_out` — no injected owner session. Getting one would mean minting a session (creating credentials), which is out of scope.
- No agent-hub token is configured here for Nabu.
- A `MUSE_API_TOKEN` value is present, but nothing shows it was issued to Nabu or maps to a hub agent with `agenthub` scope. Using it would mean borrowing another agent's identity, and even an auth probe writes `last_used_at`. So it was not used.
- No Lovable MCP tool here calls agent-hub as an authorized actor. The deploy/curl tools only make anonymous calls, which return 401.

## Precise missing access
One of:
1. A signed-in Control Center owner session for this workspace (Fendi signs in to the preview), or
2. A Muse token issued for Nabu with `agenthub` scope, mapped via `agent_hub_agents.token_label` to a Nabu agent row, made available to this workspace by Fendi.

## Context (unchanged)
Grok Bot shows awaiting_setup with no verified hub response, and the Cursor/Mac bridge last sent a heartbeat on 9 June. Even with access, handoffs to them would only queue. All other work stays parked.

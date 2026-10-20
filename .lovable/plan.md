# Posting to the Agent Hub as ChatGPT — findings (read-only)

Nothing was edited, deployed, posted, or changed.

## Result: there is no ChatGPT identity yet
The board is the `agent-hub` function (`POST /functions/v1/agent-hub`, `Authorization: Bearer <token>`, JSON `{ "action": ... }`). It works out who is posting from the token and nothing else, so an agent cannot just pick the name it posts under.

The agent registry holds these entries:
- `grok-bot`, `enki`, `claude-code-cloud`: each has 1 working token.
- `openai-api` ("ChatGPT model (OpenAI API)"): this is the hub's own server calling OpenAI. It has **no token label**, so nothing can log in as it. It is also not the ChatGPT app, and it cannot see ChatGPT chats.
- The Mac command-line agents and `grok-api` have no tokens.

So no supported way exists right now for ChatGPT to post under its own name. Using the Grok Bot or Enki token would be impersonation.

## Options that work today and don't impersonate anyone
1. **Fendi posts it (recommended for now).** Fendi signs in to the Agent Hub, taps "Bring in from another app", and sets the source to "ChatGPT app". This uses the `ingest` action with `source_app: "chatgpt-app"`. The post is labelled as an import from ChatGPT under Fendi's account, and it can be handed to Grok Bot from there.
2. **Share-sheet shortcut.** Fendi has a token issued with the scope `agenthub:ingest` and builds an iOS Shortcut that sends `{"action":"ingest","source_app":"chatgpt-app","body":...}` (see docs/AGENT_HUB.md §4). That token can only call `ingest`. The post is filed as an import, not as ChatGPT acting as an agent.

## To post as a ChatGPT agent (needs Fendi to approve; not done)
- Add an agent entry, for example `chatgpt`, with a `token_label` of `chatgpt` and the `token_inbox` transport.
- Issue a token (stored only as a SHA-256 hash) with the label `chatgpt` and the scope `agenthub`.
- ChatGPT then calls `create_thread` / `post` / `handoff` to `grok-bot` / `inbox` / `respond`, and its posts show as `chatgpt`.
- Caveat: Grok Bot's status is awaiting_setup and it has no verified response through the hub, so handoffs to it would only sit in the queue.

## Questions for Fendi
- Pick option 1/2 for now, or approve setting up a dedicated `chatgpt` identity.

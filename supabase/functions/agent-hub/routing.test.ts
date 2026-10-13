// Static guard: every message-writing path in index.ts routes its kind through
// authoredKind(), except the hub's own SYSTEM lines, decide (DECISION) and ingest (IMPORT).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("no write path accepts a caller-chosen kind without authoredKind()", () => {
  assertEquals(src.match(/oneOf\(p\.kind/g), null, "p.kind must go through authoredKind");
  const literal = [...src.matchAll(/kind: "(SYSTEM|DECISION|IMPORT)"/g)].map((m) => m[1]).sort();
  assertEquals(literal, ["DECISION", "IMPORT", "SYSTEM"], "only decide, ingest and one hub status line use reserved kinds");
});

Deno.test("hub status lines are authored by agent-hub, never by the requester", () => {
  assert(!/author: actor\.key, author_kind: actor\.type === "human" \? "human" : "system"/.test(src));
  assert(/author: "agent-hub", author_kind: "system", kind: "SYSTEM"/.test(src));
});

Deno.test("signed-in sessions are checked against control_center_owners", () => {
  assert(/from\("control_center_owners"\)/.test(src));
  assert(/status: 403/.test(src));
});

Deno.test("answers are written through the transactional RPC only", () => {
  assert(/rpc\("agent_hub_record_response"/.test(src));
  assert(/rpc\("agent_hub_fail_handoff"/.test(src));
  assertEquals(src.match(/update\(\{ status: "RESPONDED"/g), null, "no separate status write for answers");
});

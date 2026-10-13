import { assertEquals, assertMatch, assertThrows, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachments, buildPacket, effectiveAvailability, InputError, renderPacket, responseKindFor, workContext, type AgentRow,
} from "./contract.ts";

const base: AgentRow = {
  key: "x", kind: "model_api", transport: "edge_model_call", availability: "unverified", availability_note: null,
  secret_name: "Frost_Grok", bridge_cli: null, last_seen_at: null, last_verified_at: null,
};
const now = Date.parse("2026-10-12T23:00:00Z");
const env = (present: string[]) => ({ secretPresent: (n: string) => present.includes(n), now });
const noBridge = { lastSeenAt: null, capabilities: null };

Deno.test("model API without its secret is awaiting setup, never live", () => {
  const e = effectiveAvailability(base, env([]), noBridge);
  assertEquals(e.state, "awaiting_setup");
  assertMatch(e.reason, /Frost_Grok/);
});

Deno.test("model API with key but no successful call is unverified; live after one", () => {
  assertEquals(effectiveAvailability(base, env(["Frost_Grok"]), noBridge).state, "unverified");
  assertEquals(effectiveAvailability({ ...base, last_verified_at: "2026-10-12T22:00:00Z" }, env(["Frost_Grok"]), noBridge).state, "live");
});

Deno.test("Mac CLI agent needs a fresh heartbeat and the CLI reported", () => {
  const cli: AgentRow = { ...base, kind: "cli_agent", transport: "mac_bridge", secret_name: null, bridge_cli: "claude", availability: "awaiting_setup" };
  assertEquals(effectiveAvailability(cli, env([]), { lastSeenAt: "2026-06-09T17:30:11Z", capabilities: null }).state, "awaiting_setup");
  const fresh = { lastSeenAt: new Date(now - 10_000).toISOString(), capabilities: {} };
  assertMatch(effectiveAvailability(cli, env([]), fresh).reason, /not reported/);
  const withCli = { ...fresh, capabilities: { claude_cli: { path: "/usr/local/bin/claude" } } };
  assertEquals(effectiveAvailability(cli, env([]), withCli).state, "unverified");
  assertEquals(effectiveAvailability({ ...cli, last_verified_at: "x" }, env([]), withCli).state, "live");
});

Deno.test("token agents are live only after answering through the hub", () => {
  const tok: AgentRow = { ...base, kind: "agent_session", transport: "token_inbox", secret_name: null, availability: "awaiting_setup", availability_note: "needs directive" };
  assertEquals(effectiveAvailability(tok, env([]), noBridge).state, "awaiting_setup");
  assertEquals(effectiveAvailability({ ...tok, last_verified_at: "2026-10-12T22:00:00Z" }, env([]), noBridge).state, "live");
});

Deno.test("responses land as the right message kind", () => {
  assertEquals(responseKindFor("REVIEW"), "REVIEW");
  assertEquals(responseKindFor("FEEDBACK"), "REVISION");
  assertEquals(responseKindFor("TASK"), "MESSAGE");
});

Deno.test("context validation rejects a non-sha revision", () => {
  assertThrows(() => workContext({ commit_sha: "main" }), InputError);
  assertEquals(workContext({ repo: "a/b", commit_sha: "abc1234", files: ["x.ts"] }), { repo: "a/b", commit_sha: "abc1234", files: ["x.ts"] });
});

Deno.test("attachments reject path traversal", () => {
  assertThrows(() => attachments([{ name: "a", storage_path: "../etc/passwd" }]), InputError);
  assertEquals(attachments([{ name: "d.diff", text: "+x" }])[0].bytes, 2);
});

Deno.test("packet carries the exact revision, the full source and a shortened history", () => {
  const long = "y".repeat(5000);
  const p = buildPacket({
    handoff_id: "h1", purpose: "REVIEW", from_agent: "claude-code-cloud", to_agent: "grok-api", requested_by: "fendi",
    instructions: "Check the auth path.", thread: { id: "t1", title: "Agent Hub", project: "control-center" },
    source: {
      id: "m2", author: "claude-code-cloud", kind: "WORK", body: "Implemented X", created_at: "2026-10-12T22:00:00Z",
      context: { repo: "fendifrost-dot/fendi-control-center", commit_sha: "eb8397f" }, attachments: [{ name: "change.diff", text: "+line" }],
    },
    history: [
      { id: "m1", author: "fendi", kind: "MESSAGE", body: long, created_at: "2026-10-12T21:00:00Z" },
      { id: "m2", author: "claude-code-cloud", kind: "WORK", body: "dup", created_at: "2026-10-12T22:00:00Z" },
    ],
  });
  assertEquals(p.history.length, 1, "source is not repeated in history");
  assert(p.history[0].body.length < 2000, "history is shortened");
  const md = renderPacket(p);
  assertMatch(md, /Exact revision: eb8397f/);
  assertMatch(md, /```\n\+line\n```/);
  assertMatch(md, /Check the auth path\./);
  assertEquals(p.respond_with.kind, "REVIEW");
});

// Review finding 2: reserved kinds cannot be authored through any write path.
import { authoredKind } from "./contract.ts";

Deno.test("agents cannot author DECISION, SYSTEM or IMPORT", () => {
  for (const k of ["DECISION", "SYSTEM", "IMPORT"]) {
    assertThrows(() => authoredKind("agent", k, "WORK"), InputError, k);
  }
  assertEquals(authoredKind("agent", "REVIEW", "WORK"), "REVIEW");
  assertEquals(authoredKind("agent", undefined, "REVISION"), "REVISION");
});

Deno.test("Fendi posts cannot forge SYSTEM, and DECISION/IMPORT only come from decide/ingest", () => {
  for (const k of ["DECISION", "SYSTEM", "IMPORT", "REVIEW"]) {
    assertThrows(() => authoredKind("human", k, "MESSAGE"), InputError);
  }
  assertEquals(authoredKind("human", "WORK", "MESSAGE"), "WORK");
});

Deno.test("unknown kinds are rejected", () => {
  assertThrows(() => authoredKind("agent", "APPROVAL", "WORK"), InputError);
  assertThrows(() => authoredKind("agent", 7, "WORK"), InputError);
});

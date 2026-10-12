/**
 * agent-hub — shared threads, reviews and handoffs between connected agents.
 *
 * Callers and how they authenticate:
 *  - Fendi in the app: Supabase session JWT (Authorization: Bearer <access_token>) → actor "fendi".
 *  - Agents (Grok Bot, Enki, Claude Code cloud): Muse API token (muse_api_tokens) with scope
 *    `agenthub` or `workboard:write`; the token label must match agent_hub_agents.token_label.
 *  - iOS Shortcut / share sheet: Muse token with scope `agenthub:ingest` → may only call `ingest`.
 *  - Mac bridge: X-Remote-Bridge-Token (same REMOTE_BRIDGE_TOKEN as remote-bridge-api).
 *
 * All requests are POST JSON { action, ...params }. See docs/AGENT_HUB.md.
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  attachments, buildPacket, effectiveAvailability, InputError, isAction, LIMITS, MESSAGE_KINDS, oneOf,
  PURPOSES, renderPacket, responseKindFor, str, uuid, workContext,
  type AgentRow, type Attachment, type MessageKind, type Packet, type PacketMessage, type Purpose,
} from "./contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const BRIDGE_TOKEN = Deno.env.get("REMOTE_BRIDGE_TOKEN") ?? "";
const BOT_TOKEN = Deno.env.get("FendiAIbot") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const APP_URL = (Deno.env.get("CONTROL_CENTER_APP_URL") ?? "https://fendi-control-center.lovable.app").replace(/\/$/, "");
const HANDOFF_MISSION_ID = "a9e3c1f0-6b2d-4c11-9d7e-0c0c0a9e7b01";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-muse-token, x-remote-bridge-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type Actor =
  | { type: "human"; key: "fendi"; ingestOnly: boolean; via: string }
  | { type: "agent"; key: string; via: string }
  | { type: "bridge"; key: "mac-bridge"; via: "bridge-token" };

async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request, db: SupabaseClient): Promise<Actor | { error: string }> {
  const bridge = req.headers.get("x-remote-bridge-token");
  if (bridge) {
    if (BRIDGE_TOKEN && bridge === BRIDGE_TOKEN) return { type: "bridge", key: "mac-bridge", via: "bridge-token" };
    return { error: "invalid bridge token" };
  }
  const h = req.headers.get("authorization") ?? "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : (req.headers.get("x-muse-token")?.trim() ?? "");
  if (!token) return { error: "missing token" };
  if (token === SERVICE_KEY) return { error: "service-role key rejected" };

  // Supabase session JWTs have three dot-separated parts; Muse tokens do not.
  if (token.split(".").length === 3) {
    if (!ANON_KEY) return { error: "anon key not configured" };
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data } = await userClient.auth.getUser();
    if (data.user) return { type: "human", key: "fendi", ingestOnly: false, via: `session:${data.user.email ?? data.user.id}` };
    return { error: "invalid session" };
  }

  const { data: t } = await db.from("muse_api_tokens")
    .select("id,label,scopes,expires_at,revoked_at").eq("token_sha256", await sha256Hex(token)).maybeSingle();
  if (!t) return { error: "unknown token" };
  if (t.revoked_at) return { error: "token revoked" };
  if (t.expires_at && Date.parse(t.expires_at) < Date.now()) return { error: "token expired" };
  const scopes: string[] = t.scopes ?? [];
  await db.from("muse_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", t.id);
  if (scopes.includes("agenthub:ingest") && !scopes.includes("agenthub")) {
    return { type: "human", key: "fendi", ingestOnly: true, via: `token:${t.label}` };
  }
  if (!scopes.includes("agenthub") && !scopes.includes("workboard:write")) return { error: "token lacks agenthub scope" };
  const { data: agent } = await db.from("agent_hub_agents").select("key").eq("token_label", t.label).maybeSingle();
  if (!agent) return { error: `token ${t.label} is not mapped to an agent` };
  await db.from("agent_hub_agents").update({ last_seen_at: new Date().toISOString() }).eq("key", agent.key);
  return { type: "agent", key: agent.key as string, via: `token:${t.label}` };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  if (data === null) throw new InputError(`${what}: not found`);
  return data;
}

async function getAgent(db: SupabaseClient, key: string) {
  return await must(db.from("agent_hub_agents").select("*").eq("key", key).maybeSingle(), `agent ${key}`) as Record<string, any>;
}

async function insertMessage(db: SupabaseClient, row: {
  thread_id: string; author: string; author_kind: "agent" | "human" | "system"; kind: MessageKind; body: string;
  reply_to?: string | null; handoff_id?: string | null; context?: Record<string, unknown>; attachments?: Attachment[];
}) {
  const msg = await must(db.from("agent_hub_messages").insert({
    ...row, context: row.context ?? {}, attachments: row.attachments ?? [],
  }).select("*").single(), "insert message") as Record<string, any>;
  await db.from("agent_hub_threads").update({ last_activity_at: msg.created_at }).eq("id", row.thread_id);
  return msg;
}

async function refreshThreadStatus(db: SupabaseClient, threadId: string) {
  const { data: thread } = await db.from("agent_hub_threads").select("status").eq("id", threadId).maybeSingle();
  if (!thread || ["DONE", "ARCHIVED"].includes(thread.status)) return;
  const { count } = await db.from("agent_hub_handoffs").select("id", { count: "exact", head: true })
    .eq("thread_id", threadId).in("status", ["QUEUED", "DELIVERED", "IN_PROGRESS"]);
  await db.from("agent_hub_threads").update({ status: (count ?? 0) > 0 ? "WAITING_ON_AGENT" : "WAITING_ON_FENDI" }).eq("id", threadId);
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|sql))/;

/** Inline small text files from storage so model APIs can read them too. */
async function hydrateAttachments(db: SupabaseClient, list: Attachment[]): Promise<Attachment[]> {
  let budget = LIMITS.attachmentsText;
  const out: Attachment[] = [];
  for (const a of list) {
    budget -= a.text?.length ?? 0;
    if (a.text || !a.storage_path) { out.push(a); continue; }
    const textLike = (a.mime && TEXT_MIME.test(a.mime)) || /\.(md|txt|ts|tsx|js|json|sql|py|diff|patch|csv|yml|yaml|html|css)$/i.test(a.name);
    const { data: signed } = await db.storage.from("agent-hub").createSignedUrl(a.storage_path, 60 * 60 * 24 * 7);
    let text: string | null = null;
    if (textLike && (a.bytes ?? 0) <= 256_000 && budget > 0) {
      const { data: blob } = await db.storage.from("agent-hub").download(a.storage_path);
      if (blob) { text = (await blob.text()).slice(0, budget); budget -= text.length; }
    }
    out.push({ ...a, text, url: signed?.signedUrl ?? a.url ?? null });
  }
  return out;
}

function toPacketMessage(m: Record<string, any>): PacketMessage {
  return { id: m.id, author: m.author, kind: m.kind, body: m.body, created_at: m.created_at, context: m.context ?? {}, attachments: m.attachments ?? [] };
}

async function bridgeDevice(db: SupabaseClient) {
  const { data } = await db.from("remote_bridge_devices").select("id,device_name,last_seen_at,capabilities")
    .eq("status", "active").order("last_seen_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  return data as { id: string; device_name: string; last_seen_at: string | null; capabilities: any } | null;
}

async function agentsWithState(db: SupabaseClient) {
  const { data: agents } = await db.from("agent_hub_agents").select("*").order("sort_order");
  const device = await bridgeDevice(db);
  const caps = device?.capabilities && !Array.isArray(device.capabilities) ? device.capabilities : null;
  const now = Date.now();
  return (agents ?? []).map((a: Record<string, any>): Record<string, any> => ({
    ...a,
    effective: effectiveAvailability(a as AgentRow, { secretPresent: (n) => Boolean(Deno.env.get(n)), now }, {
      lastSeenAt: device?.last_seen_at ?? null, capabilities: caps,
    }),
  }));
}

async function notifyFendi(text: string) {
  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram notify failed", e); }
}

function background(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else p.catch((e) => console.error(e));
}

// ---------------------------------------------------------------------------
// Responding (shared by inbox agents, bridge results and model calls)
// ---------------------------------------------------------------------------

async function recordResponse(db: SupabaseClient, handoff: Record<string, any>, input: {
  body: string; kind?: MessageKind; context?: Record<string, unknown>; attachments?: Attachment[]; session_id?: string | null; meta?: Record<string, unknown>;
}) {
  if (["RESPONDED", "CANCELLED"].includes(handoff.status)) throw new InputError(`handoff already ${handoff.status}`);
  const msg = await insertMessage(db, {
    thread_id: handoff.thread_id, author: handoff.to_agent, author_kind: "agent",
    kind: input.kind ?? responseKindFor(handoff.purpose as Purpose), body: input.body,
    reply_to: handoff.source_message_id, handoff_id: handoff.id, context: input.context, attachments: input.attachments,
  });
  const now = new Date().toISOString();
  await db.from("agent_hub_handoffs").update({
    status: "RESPONDED", response_message_id: msg.id, responded_at: now, error: null,
    delivery: { ...(handoff.delivery ?? {}), ...(input.meta ?? {}) },
  }).eq("id", handoff.id);
  await db.from("agent_hub_agents").update({ last_verified_at: now, last_seen_at: now }).eq("key", handoff.to_agent);
  if (input.session_id) {
    await db.from("agent_hub_sessions").upsert({
      thread_id: handoff.thread_id, agent_key: handoff.to_agent, external_session_id: input.session_id, updated_at: now,
      meta: input.meta ?? {},
    });
  }
  await refreshThreadStatus(db, handoff.thread_id);
  const { data: thread } = await db.from("agent_hub_threads").select("title").eq("id", handoff.thread_id).maybeSingle();
  await notifyFendi(`${handoff.to_agent} answered (${msg.kind}) on "${thread?.title ?? "thread"}"\n${input.body.slice(0, 280)}${input.body.length > 280 ? "…" : ""}\n${APP_URL}/agents/t/${handoff.thread_id}`);
  return msg;
}

async function failHandoff(db: SupabaseClient, handoff: Record<string, any>, error: string) {
  await db.from("agent_hub_handoffs").update({ status: "FAILED", error: error.slice(0, 2000) }).eq("id", handoff.id);
  await insertMessage(db, {
    thread_id: handoff.thread_id, author: "agent-hub", author_kind: "system", kind: "SYSTEM",
    body: `Handoff to ${handoff.to_agent} failed: ${error.slice(0, 1000)}`, handoff_id: handoff.id, reply_to: handoff.source_message_id,
  });
  await refreshThreadStatus(db, handoff.thread_id);
}

// ---------------------------------------------------------------------------
// Delivery per transport
// ---------------------------------------------------------------------------

const MODEL_ENDPOINTS: Record<string, string> = {
  Frost_Grok: "https://api.x.ai/v1/chat/completions",
  OPENAI_API_KEY: "https://api.openai.com/v1/chat/completions",
};

async function runModelCall(db: SupabaseClient, handoff: Record<string, any>, agent: Record<string, any>, packetText: string) {
  const key = Deno.env.get(agent.secret_name ?? "") ?? "";
  const endpoint = MODEL_ENDPOINTS[agent.secret_name ?? ""];
  if (!key || !endpoint) { await failHandoff(db, handoff, `secret ${agent.secret_name} not set`); return; }
  await db.from("agent_hub_handoffs").update({ status: "IN_PROGRESS" }).eq("id", handoff.id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 140_000);
  const started = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 2500,
        messages: [
          {
            role: "system",
            content: `You are ${agent.display_name}, one of several AI agents collaborating in Fendi's Control Center. ` +
              "You only see the packet below. You cannot open links, run code or browse a repository, so say plainly when something cannot be verified from the packet. " +
              "Be specific and concise; use short headed sections and numbered points. Do not invent file contents.",
          },
          { role: "user", content: packetText },
        ],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) { await failHandoff(db, handoff, `${agent.model} HTTP ${resp.status}: ${raw.slice(0, 500)}`); return; }
    const data = JSON.parse(raw);
    const text: string = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) { await failHandoff(db, handoff, `${agent.model} returned an empty answer`); return; }
    await recordResponse(db, handoff, {
      body: text,
      meta: { model: data.model ?? agent.model, usage: data.usage ?? null, latency_ms: Date.now() - started, provider_response_id: data.id ?? null },
    });
  } catch (e) {
    await failHandoff(db, handoff, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(db: SupabaseClient, handoff: Record<string, any>, agent: Record<string, any>, packet: Packet) {
  const packetText = renderPacket(packet);
  if (agent.transport === "edge_model_call") {
    background(runModelCall(db, handoff, agent, packetText));
    return { transport: "edge_model_call", model: agent.model };
  }
  if (agent.transport === "mac_bridge") {
    const { data: session } = await db.from("agent_hub_sessions").select("external_session_id")
      .eq("thread_id", handoff.thread_id).eq("agent_key", agent.key).maybeSingle();
    const ctx = packet.source?.context ?? {};
    const { data: cmd, error } = await db.from("remote_command_queue").insert({
      device_id: null, source: "agent_hub", source_ref: handoff.id, command_type: "agent_handoff", status: "queued",
      payload: {
        handoff_id: handoff.id, thread_id: handoff.thread_id, agent_key: agent.key, cli: agent.bridge_cli, purpose: handoff.purpose,
        prompt: packetText, repo: ctx.repo ?? null, commit_sha: ctx.commit_sha ?? null,
        resume_session_id: session?.external_session_id ?? null,
        read_only: ["REVIEW", "QUESTION"].includes(handoff.purpose),
      },
    }).select("id, expires_at").single();
    if (error) throw new Error(`enqueue bridge command: ${error.message}`);
    const delivery = { transport: "mac_bridge", bridge_command_id: cmd.id, expires_at: cmd.expires_at, resumes_session: session?.external_session_id ?? null };
    await db.from("agent_hub_handoffs").update({ status: "DELIVERED", delivered_at: new Date().toISOString(), delivery }).eq("id", handoff.id);
    return delivery;
  }
  if (agent.transport === "token_inbox") {
    const delivery: Record<string, unknown> = { transport: "token_inbox" };
    if (agent.workboard_mirror) {
      const { data: thread } = await db.from("agent_hub_threads").select("title").eq("id", handoff.thread_id).maybeSingle();
      const message = [
        `[Agent Hub → ${agent.display_name}] ${handoff.purpose} requested by ${handoff.requested_by} on "${thread?.title ?? "thread"}".`,
        `Handoff id: ${handoff.id}`,
        `Read the full packet: POST ${SUPABASE_URL}/functions/v1/agent-hub {"action":"inbox"} with your ${agent.token_label} token.`,
        `Answer: {"action":"respond","handoff_id":"${handoff.id}","body":"..."}. Do not answer on the workboard.`,
        handoff.instructions ? `Instructions: ${String(handoff.instructions).slice(0, 1200)}` : "",
      ].filter(Boolean).join("\n");
      const { data: wu, error } = await db.from("muse_work_updates").insert({
        domain_key: "ai_technical_systems", mission_id: HANDOFF_MISSION_ID, actor: "agent-hub",
        update_type: "ASSIGNMENT", message, evidence_ref: `agent_hub_handoff:${handoff.id}`,
      }).select("id").single();
      if (error) delivery.workboard_error = error.message; else delivery.workboard_update_id = wu.id;
    }
    await db.from("agent_hub_handoffs").update({ delivery }).eq("id", handoff.id);
    return delivery;
  }
  throw new InputError(`agent ${agent.key} cannot receive handoffs`);
}

async function createHandoff(db: SupabaseClient, actor: Actor, input: {
  thread_id: string; source_message_id: string | null; to_agent: string; purpose: Purpose; instructions: string | null; from_agent?: string;
}) {
  const agent = await getAgent(db, input.to_agent);
  if (agent.kind === "human") throw new InputError("Fendi is not a handoff target; post a message instead");
  if (agent.availability === "disabled") throw new InputError(`${agent.display_name} is disabled: ${agent.availability_note ?? ""}`);
  const thread = await must(db.from("agent_hub_threads").select("id,title,project").eq("id", input.thread_id).maybeSingle(), "thread") as Record<string, any>;
  let source: Record<string, any> | null = null;
  if (input.source_message_id) {
    source = await must(db.from("agent_hub_messages").select("*").eq("id", input.source_message_id).eq("thread_id", thread.id).maybeSingle(), "source message");
  }
  const { data: hist } = await db.from("agent_hub_messages").select("*").eq("thread_id", thread.id)
    .order("created_at", { ascending: false }).limit(LIMITS.historyCount + 1);
  const history = (hist ?? []).reverse().map(toPacketMessage);

  const from_agent = input.from_agent ?? actor.key;
  const handoff = await must(db.from("agent_hub_handoffs").insert({
    thread_id: thread.id, source_message_id: source?.id ?? null, from_agent, to_agent: agent.key,
    purpose: input.purpose, instructions: input.instructions, requested_by: actor.key, status: "QUEUED",
  }).select("*").single(), "insert handoff") as Record<string, any>;

  const sourcePM = source ? { ...toPacketMessage(source), attachments: await hydrateAttachments(db, source.attachments ?? []) } : null;
  const packet = buildPacket({
    handoff_id: handoff.id, purpose: input.purpose, from_agent, to_agent: agent.key, requested_by: actor.key,
    instructions: input.instructions, thread: { id: thread.id, title: thread.title, project: thread.project ?? null },
    source: sourcePM, history,
  });
  await db.from("agent_hub_handoffs").update({ context: packet }).eq("id", handoff.id);
  await insertMessage(db, {
    thread_id: thread.id, author: actor.key, author_kind: actor.type === "human" ? "human" : "system", kind: "SYSTEM",
    body: `${input.purpose} handoff to ${agent.display_name}${source ? ` of ${source.author}'s ${String(source.kind).toLowerCase()}` : ""}.${input.instructions ? ` Instructions: ${input.instructions}` : ""}`,
    handoff_id: handoff.id, reply_to: source?.id ?? null,
  });
  await db.from("agent_hub_threads").update({ status: "WAITING_ON_AGENT" }).eq("id", thread.id);

  let delivery: unknown;
  try {
    delivery = await deliver(db, handoff, agent, packet);
  } catch (e) {
    await failHandoff(db, handoff, e instanceof Error ? e.message : String(e));
    throw e;
  }
  const effective = (await agentsWithState(db)).find((a) => a.key === agent.key)?.effective;
  return { handoff_id: handoff.id, to_agent: agent.key, delivery, receiver_state: effective };
}

/** Mark bridge handoffs failed when their queue row failed or expired. */
async function sweepBridgeHandoffs(db: SupabaseClient, threadId?: string) {
  let q = db.from("agent_hub_handoffs").select("*").in("status", ["DELIVERED", "IN_PROGRESS"]).eq("delivery->>transport", "mac_bridge");
  if (threadId) q = q.eq("thread_id", threadId);
  const { data } = await q.limit(50);
  for (const h of data ?? []) {
    const cmdId = h.delivery?.bridge_command_id;
    if (!cmdId) continue;
    const { data: cmd } = await db.from("remote_command_queue").select("status,error,expires_at").eq("id", cmdId).maybeSingle();
    if (!cmd) continue;
    if (cmd.status === "failed") await failHandoff(db, h, `bridge: ${cmd.error ?? "failed"}`);
    else if (cmd.status === "queued" && Date.parse(cmd.expires_at) < Date.now()) {
      await db.from("remote_command_queue").update({ status: "cancelled" }).eq("id", cmdId);
      await failHandoff(db, h, "Mac bridge did not pick this up before it expired (24h). Start the bridge, then retry.");
    } else if (cmd.status === "claimed" && h.status === "DELIVERED") {
      await db.from("agent_hub_handoffs").update({ status: "IN_PROGRESS" }).eq("id", h.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function requireHuman(actor: Actor) {
  if (actor.type !== "human" || actor.ingestOnly) throw new InputError("only Fendi (signed in) can do this");
}

async function handle(db: SupabaseClient, actor: Actor, action: string, p: Record<string, unknown>) {
  if (actor.type === "human" && actor.ingestOnly && action !== "ingest") throw new InputError("ingest-only token");
  if (actor.type === "bridge" && !["bridge_capabilities", "bridge_result", "health"].includes(action)) {
    throw new InputError("bridge token may only report capabilities and results");
  }

  switch (action) {
    case "health": {
      const agents = await agentsWithState(db);
      const device = await bridgeDevice(db);
      return {
        ok: true, actor: { key: actor.key, type: actor.type },
        bridge: device ? { device_name: device.device_name, last_seen_at: device.last_seen_at, capabilities: device.capabilities } : null,
        agents: agents.map((a) => ({ key: a.key, display_name: a.display_name, kind: a.kind, effective: a.effective })),
      };
    }
    case "agents":
      return { agents: await agentsWithState(db) };

    case "threads": {
      let q = db.from("agent_hub_threads").select("*").order("last_activity_at", { ascending: false }).limit(Math.min(Number(p.limit ?? 50), 200));
      if (p.status) q = q.eq("status", String(p.status));
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { threads: data };
    }
    case "thread": {
      const id = uuid(p.thread_id, "thread_id")!;
      await sweepBridgeHandoffs(db, id);
      const thread = await must(db.from("agent_hub_threads").select("*").eq("id", id).maybeSingle(), "thread");
      const { data: messages } = await db.from("agent_hub_messages").select("*").eq("thread_id", id).order("created_at");
      const { data: handoffs } = await db.from("agent_hub_handoffs").select("*").eq("thread_id", id).order("created_at");
      return { thread, messages, handoffs };
    }
    case "create_thread": {
      if (actor.type === "bridge") throw new InputError("not allowed");
      const thread = await must(db.from("agent_hub_threads").insert({
        title: str(p.title, "title", 300, true), project: str(p.project, "project", 200),
        mission_id: uuid(p.mission_id, "mission_id", false), task_id: uuid(p.task_id, "task_id", false),
        primary_agent: str(p.primary_agent, "primary_agent", 100), created_by: actor.key,
      }).select("*").single(), "create thread") as Record<string, any>;
      let message = null;
      const body = str(p.body, "body", LIMITS.body);
      if (body) {
        message = await insertMessage(db, {
          thread_id: thread.id, author: actor.key, author_kind: actor.type === "human" ? "human" : "agent",
          kind: oneOf(p.kind, "kind", MESSAGE_KINDS, actor.type === "human" ? "MESSAGE" : "WORK"), body,
          context: workContext(p.context), attachments: attachments(p.attachments),
        });
      }
      return { thread, message };
    }
    case "post": {
      const thread_id = uuid(p.thread_id, "thread_id")!;
      const kind = oneOf(p.kind, "kind", MESSAGE_KINDS, "MESSAGE");
      if (kind === "DECISION" || kind === "SYSTEM") throw new InputError(`use the ${kind === "DECISION" ? "decide" : "system"} path for ${kind}`);
      const msg = await insertMessage(db, {
        thread_id, author: actor.key, author_kind: actor.type === "human" ? "human" : "agent", kind,
        body: str(p.body, "body", LIMITS.body, true)!, reply_to: uuid(p.reply_to, "reply_to", false),
        context: workContext(p.context), attachments: attachments(p.attachments),
      });
      // A message addressed to an agent becomes a handoff so the agent actually receives it.
      let handoff = null;
      const to = str(p.to_agent, "to_agent", 100);
      if (to) {
        handoff = await createHandoff(db, actor, {
          thread_id, source_message_id: msg.id, to_agent: to,
          purpose: oneOf(p.purpose, "purpose", PURPOSES, "TASK"), instructions: str(p.instructions, "instructions", LIMITS.instructions),
        });
      } else if (actor.type === "human") {
        await refreshThreadStatus(db, thread_id);
      }
      return { message: msg, handoff };
    }
    case "handoff": {
      return await createHandoff(db, actor, {
        thread_id: uuid(p.thread_id, "thread_id")!, source_message_id: uuid(p.source_message_id, "source_message_id", false),
        to_agent: str(p.to_agent, "to_agent", 100, true)!, purpose: oneOf(p.purpose, "purpose", PURPOSES, "REVIEW"),
        instructions: str(p.instructions, "instructions", LIMITS.instructions),
      });
    }
    case "return_to_origin": {
      // Send a review (or any reply) back to the agent whose work it answered.
      const msgId = uuid(p.message_id, "message_id")!;
      const reply = await must(db.from("agent_hub_messages").select("*").eq("id", msgId).maybeSingle(), "message") as Record<string, any>;
      let originAuthor: string | null = null;
      if (reply.handoff_id) {
        const h = await must(db.from("agent_hub_handoffs").select("source_message_id").eq("id", reply.handoff_id).maybeSingle(), "handoff") as Record<string, any>;
        if (h.source_message_id) {
          const src = await must(db.from("agent_hub_messages").select("author").eq("id", h.source_message_id).maybeSingle(), "source") as Record<string, any>;
          originAuthor = src.author;
        }
      } else if (reply.reply_to) {
        const src = await must(db.from("agent_hub_messages").select("author").eq("id", reply.reply_to).maybeSingle(), "source") as Record<string, any>;
        originAuthor = src.author;
      }
      if (!originAuthor) throw new InputError("could not find whose work this message answers");
      if (originAuthor === "fendi") throw new InputError("the original work is yours; nothing to return");
      return await createHandoff(db, actor, {
        thread_id: reply.thread_id, source_message_id: reply.id, to_agent: originAuthor, purpose: "FEEDBACK",
        instructions: str(p.instructions, "instructions", LIMITS.instructions), from_agent: reply.author,
      });
    }
    case "inbox": {
      if (actor.type !== "agent") throw new InputError("inbox is for agent tokens");
      const { data } = await db.from("agent_hub_handoffs").select("*").eq("to_agent", actor.key)
        .in("status", ["QUEUED", "DELIVERED", "IN_PROGRESS"]).order("created_at").limit(Math.min(Number(p.limit ?? 10), 25));
      const now = new Date().toISOString();
      const ids = (data ?? []).filter((h) => h.status === "QUEUED").map((h) => h.id);
      if (ids.length) await db.from("agent_hub_handoffs").update({ status: "DELIVERED", delivered_at: now }).in("id", ids);
      return {
        handoffs: (data ?? []).map((h) => ({
          id: h.id, thread_id: h.thread_id, purpose: h.purpose, from_agent: h.from_agent, requested_by: h.requested_by,
          instructions: h.instructions, created_at: h.created_at, packet: h.context, packet_markdown: renderPacket(h.context as Packet),
        })),
      };
    }
    case "respond": {
      const id = uuid(p.handoff_id, "handoff_id")!;
      const h = await must(db.from("agent_hub_handoffs").select("*").eq("id", id).maybeSingle(), "handoff") as Record<string, any>;
      if (actor.key !== h.to_agent) throw new InputError(`this handoff is addressed to ${h.to_agent}`);
      const msg = await recordResponse(db, h, {
        body: str(p.body, "body", LIMITS.body, true)!, kind: p.kind ? oneOf(p.kind, "kind", MESSAGE_KINDS) : undefined,
        context: workContext(p.context), attachments: attachments(p.attachments), session_id: str(p.session_id, "session_id", 300),
        meta: { responded_via: actor.via },
      });
      return { message: msg };
    }
    case "decide": {
      requireHuman(actor);
      const thread_id = uuid(p.thread_id, "thread_id")!;
      const decision = oneOf(p.decision, "decision", ["APPROVED", "CHANGES_REQUESTED", "REJECTED", "NOTE"] as const);
      const msg = await insertMessage(db, {
        thread_id, author: "fendi", author_kind: "human", kind: "DECISION",
        body: str(p.body, "body", LIMITS.body) ?? decision.replace("_", " ").toLowerCase(),
        reply_to: uuid(p.message_id, "message_id", false), context: { decision },
      });
      if (decision === "APPROVED" && p.close === true) await db.from("agent_hub_threads").update({ status: "DONE" }).eq("id", thread_id);
      return { message: msg };
    }
    case "set_thread_status": {
      requireHuman(actor);
      const status = oneOf(p.status, "status", ["OPEN", "WAITING_ON_AGENT", "WAITING_ON_FENDI", "DONE", "ARCHIVED"] as const);
      await db.from("agent_hub_threads").update({ status }).eq("id", uuid(p.thread_id, "thread_id")!);
      return { ok: true };
    }
    case "cancel_handoff": {
      requireHuman(actor);
      const id = uuid(p.handoff_id, "handoff_id")!;
      const h = await must(db.from("agent_hub_handoffs").select("*").eq("id", id).maybeSingle(), "handoff") as Record<string, any>;
      await db.from("agent_hub_handoffs").update({ status: "CANCELLED" }).eq("id", id);
      if (h.delivery?.bridge_command_id) {
        await db.from("remote_command_queue").update({ status: "cancelled" }).eq("id", h.delivery.bridge_command_id).eq("status", "queued");
      }
      await refreshThreadStatus(db, h.thread_id);
      return { ok: true };
    }
    case "retry_handoff": {
      requireHuman(actor);
      const id = uuid(p.handoff_id, "handoff_id")!;
      const h = await must(db.from("agent_hub_handoffs").select("*").eq("id", id).maybeSingle(), "handoff") as Record<string, any>;
      if (!["FAILED", "CANCELLED"].includes(h.status)) throw new InputError(`handoff is ${h.status}`);
      return await createHandoff(db, actor, {
        thread_id: h.thread_id, source_message_id: h.source_message_id, to_agent: h.to_agent, purpose: h.purpose,
        instructions: h.instructions, from_agent: h.from_agent,
      });
    }
    case "ingest": {
      if (actor.type !== "human") throw new InputError("ingest is for Fendi");
      const source_app = str(p.source_app, "source_app", 100) ?? "share";
      const body = str(p.body, "body", LIMITS.body, true)!;
      let thread_id = uuid(p.thread_id, "thread_id", false);
      if (!thread_id) {
        const title = str(p.title, "title", 300) ?? `${body.split("\n")[0].slice(0, 80)}`;
        const t = await must(db.from("agent_hub_threads").insert({
          title, project: str(p.project, "project", 200), created_by: "fendi", status: "WAITING_ON_FENDI",
        }).select("id").single(), "create thread") as Record<string, any>;
        thread_id = t.id;
      }
      const msg = await insertMessage(db, {
        thread_id: thread_id!, author: "fendi", author_kind: "human", kind: "IMPORT", body,
        context: workContext({ ...((p.context as object) ?? {}), source_app, external_url: p.url ?? undefined }),
        attachments: attachments(p.attachments),
      });
      let handoff = null;
      const to = str(p.to_agent, "to_agent", 100);
      if (to) {
        handoff = await createHandoff(db, actor, {
          thread_id: thread_id!, source_message_id: msg.id, to_agent: to, purpose: oneOf(p.purpose, "purpose", PURPOSES, "REVIEW"),
          instructions: str(p.instructions, "instructions", LIMITS.instructions),
        });
      }
      return { thread_id, message: msg, handoff, open_url: `${APP_URL}/agents/t/${thread_id}` };
    }
    case "bridge_capabilities": {
      if (actor.type !== "bridge") throw new InputError("bridge only");
      const device_id = uuid(p.device_id, "device_id")!;
      const caps = (p.capabilities && typeof p.capabilities === "object") ? p.capabilities : {};
      await db.from("remote_bridge_devices").update({ capabilities: { ...caps, reported_at: new Date().toISOString() } }).eq("id", device_id);
      return { ok: true };
    }
    case "bridge_result": {
      if (actor.type !== "bridge") throw new InputError("bridge only");
      const id = uuid(p.handoff_id, "handoff_id")!;
      const h = await must(db.from("agent_hub_handoffs").select("*").eq("id", id).maybeSingle(), "handoff") as Record<string, any>;
      if (h.delivery?.transport !== "mac_bridge") throw new InputError("handoff was not delivered through the bridge");
      if (p.ok === false) { await failHandoff(db, h, str(p.error, "error", 4000) ?? "bridge run failed"); return { ok: true }; }
      const msg = await recordResponse(db, h, {
        body: str(p.body, "body", LIMITS.body, true)!, session_id: str(p.session_id, "session_id", 300),
        context: workContext(p.context), attachments: attachments(p.attachments),
        meta: { responded_via: "mac-bridge", run: (p.meta && typeof p.meta === "object") ? p.meta : {} },
      });
      return { ok: true, message_id: msg.id };
    }
    case "imessage_send":
    case "imessage_read": {
      requireHuman(actor);
      const payload = action === "imessage_send"
        ? { to: str(p.to, "to", 200, true), text: str(p.text, "text", 4000, true) }
        : { handle: str(p.handle, "handle", 200), limit: Math.min(Number(p.limit ?? 20), 100) };
      const { data, error } = await db.from("remote_command_queue").insert({
        device_id: null, source: "agent_hub", command_type: action, payload, status: "queued",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      }).select("id, status, expires_at").single();
      if (error) throw new Error(error.message);
      return { command: data };
    }
  }
  throw new InputError(`unknown action ${action}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = body.action;
  if (!isAction(action)) return json({ error: "unknown_action", action }, 400);

  const actor = await authenticate(req, db);
  if ("error" in actor) return json({ error: "unauthorized", message: actor.error }, 401);
  try {
    const result = await handle(db, actor, action, body);
    return json({ ok: true, ...result as object });
  } catch (e) {
    if (e instanceof InputError) return json({ error: "bad_request", message: e.message }, 400);
    console.error("agent-hub", action, e);
    return json({ error: "server_error", message: e instanceof Error ? e.message : String(e) }, 500);
  }
});

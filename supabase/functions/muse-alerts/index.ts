/**
 * muse-alerts — wake agents when a workboard post is addressed to them.
 *
 * GET                         open queue for the caller: unacked posts since they were registered (scope: read)
 * GET  ?since=               same posts after an explicit cursor, including ones already acked (scope: read)
 * GET  ?subscribers=1        list registry metadata (scope: alerts:admin)
 * POST ack                   mark open-queue posts done (scope: read). No idempotency key.
 * POST register_subscriber | update_subscriber | disable_subscriber (alerts:admin)
 * POST dispatch (alerts:admin or alerts:dispatch)
 * POST route_inbox           copy tagged board assignments into Claude's inbox (alerts:admin)
 *
 * Webhook URLs and bearers are sealed before they are written. Responses
 * contain the host and a 4-character hint, never the URL or the key.
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createMuseAlertStore, type StoredSubscriber, type SubscriberWrite } from "../_shared/museAlertStore.ts";
import {
  canonicalJson,
  dispatchDue,
  errorMessage,
  keyHint,
  parseAck,
  parseAgentKey,
  parseCursor,
  parseRegister,
  parseUpdate,
  pullAlerts,
  pullOpen,
  readSealKey,
  sealText,
  sha256Hex,
  subscriberFromToken,
  webhookEndpoint,
  type AlertRole,
  type SubscriberPublic,
} from "../_shared/museAlerts.ts";
import {
  authenticateMuseToken,
  databaseTimeoutBody,
  isDatabaseTimeout,
  MUSE_DB_TIMEOUT_MS,
} from "../_shared/museTokenAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENV_TOKEN = (Deno.env.get("MUSE_API_TOKEN") ?? "").trim();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-muse-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return req.headers.get("x-muse-token")?.trim() || null;
}

function createDb() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(MUSE_DB_TIMEOUT_MS) }),
    },
  });
}

function timeoutJson() {
  return json(databaseTimeoutBody(), 503);
}

function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope);
}

async function sealKey() {
  try {
    return await readSealKey(Deno.env.get("MUSE_ALERT_SEAL_KEY"));
  } catch {
    throw new Error("seal_key_invalid");
  }
}

function httpFor(code: string): { status: number; body: Record<string, unknown> } {
  if (code === "seal_key_missing" || code === "seal_key_invalid") {
    return { status: 503, body: { ok: false, error: code, message: errorMessage(code) } };
  }
  if (code === "subscriber_not_found") {
    return { status: 404, body: { ok: false, error: code, message: errorMessage(code) } };
  }
  if (code.endsWith("_failed")) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "alert_store_unavailable",
        message: "The alert tables could not be used. Apply the Muse alert migration first.",
      },
    };
  }
  const message = errorMessage(code);
  if (message === "request rejected" && code !== "request rejected") {
    return { status: 400, body: { ok: false, error: "rejected", message: "request rejected" } };
  }
  return { status: 400, body: { ok: false, error: code, message } };
}

function publicBody(action: string, saved: SubscriberPublic) {
  return { ok: true, action, ...saved };
}

async function sealedPair(url: string, key: string) {
  const opened = await sealKey();
  if (!opened) throw new Error("seal_key_missing");
  const endpoint = webhookEndpoint(url);
  return {
    webhook_url_sealed: await sealText(url, opened),
    webhook_key_sealed: await sealText(key, opened),
    webhook_host: endpoint.host,
    webhook_key_hint: keyHint(key),
  };
}

interface SealFields {
  webhook_url_sealed: string | null;
  webhook_key_sealed: string | null;
  webhook_host: string | null;
  webhook_key_hint: string | null;
}

const EMPTY_SEAL: SealFields = {
  webhook_url_sealed: null,
  webhook_key_sealed: null,
  webhook_host: null,
  webhook_key_hint: null,
};

function writeRow(fields: {
  agent_key: string;
  roles: AlertRole[];
  aliases: string[];
  delivery: "webhook" | "pull";
  enabled: boolean;
}, sealed: SealFields): SubscriberWrite {
  return { ...fields, ...sealed };
}

async function register(store: ReturnType<typeof createMuseAlertStore>, payload: unknown) {
  const input = parseRegister(payload);
  const sealed = input.delivery === "webhook" && input.webhook_url && input.webhook_key
    ? await sealedPair(input.webhook_url, input.webhook_key)
    : EMPTY_SEAL;
  const saved = await store.save(writeRow({
    agent_key: input.agent_key,
    roles: input.roles,
    aliases: input.aliases,
    delivery: input.delivery,
    enabled: input.enabled,
  }, sealed));
  return publicBody("register_subscriber", saved);
}

async function update(store: ReturnType<typeof createMuseAlertStore>, payload: unknown) {
  const input = parseUpdate(payload);
  if (input.delivery === "pull" && (input.webhook_url || input.webhook_key)) {
    throw new Error("pull_rejects_webhook");
  }
  const current = await store.find(input.agent_key);
  if (!current) throw new Error("subscriber_not_found");
  let delivery = input.delivery ?? current.delivery;
  let sealed: SealFields = {
    webhook_url_sealed: current.webhook_url_sealed,
    webhook_key_sealed: current.webhook_key_sealed,
    webhook_host: current.webhook_host,
    webhook_key_hint: current.webhook_key_hint,
  };
  if (input.webhook_url && input.webhook_key) {
    sealed = await sealedPair(input.webhook_url, input.webhook_key);
    delivery = "webhook";
  }
  if (delivery === "pull") sealed = EMPTY_SEAL;
  if (delivery === "webhook" && (!sealed.webhook_url_sealed || !sealed.webhook_key_sealed)) {
    throw new Error("webhook_incomplete");
  }
  const saved = await store.save(writeRow({
    agent_key: input.agent_key,
    roles: input.roles ?? current.roles,
    aliases: input.aliases ?? current.aliases,
    delivery,
    enabled: input.enabled ?? current.enabled,
  }, sealed));
  return publicBody("update_subscriber", saved);
}

async function disable(store: ReturnType<typeof createMuseAlertStore>, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload_rejected");
  const agentKey = parseAgentKey((payload as Record<string, unknown>).agent_key);
  const current = await store.find(agentKey);
  if (!current) throw new Error("subscriber_not_found");
  const saved = await store.save({
    agent_key: current.agent_key,
    roles: current.roles,
    aliases: current.aliases,
    delivery: current.delivery,
    enabled: false,
    webhook_url_sealed: current.webhook_url_sealed,
    webhook_key_sealed: current.webhook_key_sealed,
    webhook_host: current.webhook_host,
    webhook_key_hint: current.webhook_key_hint,
  });
  return publicBody("disable_subscriber", saved);
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    if (isDatabaseTimeout(error)) return timeoutJson();
    console.error("muse_alerts_unhandled");
    return json({ ok: false, error: "database_unavailable", message: "The database request failed." }, 503);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const db = createDb();
  const auth = await authenticateMuseToken({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    token: tokenFrom(req),
    envToken: ENV_TOKEN,
  });
  if (!auth.ok) {
    if (auth.status === 503) return json({ ok: false, error: auth.error, message: auth.message }, 503);
    return json({ ok: false, error: "unauthorized", message: auth.message }, 401);
  }
  const store = createMuseAlertStore(db);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const subscribers = url.searchParams.get("subscribers");
    const hasSince = url.searchParams.has("since");
    if (subscribers === "1" && hasSince) {
      return json({ ok: false, error: "rejected", message: "Ask for subscribers or a cursor, not both." }, 400);
    }
    if (subscribers === "1") {
      if (!hasScope(auth.scopes, "alerts:admin")) {
        return json({ ok: false, error: "unauthorized", message: "token lacks alerts:admin scope" }, 401);
      }
      try {
        const data = await store.listPublic();
        return json({ ok: true, row_count: data.length, data });
      } catch (e) {
        if (isDatabaseTimeout(e)) return timeoutJson();
        const code = e instanceof Error ? e.message : "subscribers_read_failed";
        const mapped = httpFor(code);
        return json(mapped.body, mapped.status);
      }
    }
    if (!hasScope(auth.scopes, "read")) {
      return json({ ok: false, error: "unauthorized", message: "token lacks read scope" }, 401);
    }
    const requested = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), 50) : 20;
    try {
      const subscriber = subscriberFromToken(auth.label, await store.findByAgent(auth.label));
      if (!url.searchParams.has("since")) {
        const page = await pullOpen({ store, subscriber, limit });
        return json({
          ok: true,
          mode: "open",
          agent_key: subscriber.agent_key,
          delivery: subscriber.delivery,
          floor: page.floor,
          next_cursor: page.next_cursor,
          row_count: page.data.length,
          data: page.data,
        });
      }
      const cursor = parseCursor(url.searchParams.get("since"), url.searchParams.get("since_id"));
      const page = await pullAlerts({ store, subscriber, cursor, limit });
      return json({
        ok: true,
        mode: "cursor",
        agent_key: subscriber.agent_key,
        delivery: subscriber.delivery,
        since: cursor,
        next_cursor: page.next_cursor,
        row_count: page.data.length,
        data: page.data,
      });
    } catch (e) {
      if (isDatabaseTimeout(e)) return timeoutJson();
      const code = e instanceof Error ? e.message : "events_read_failed";
      const mapped = httpFor(code);
      return json(mapped.body, mapped.status);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const action = body.action;

  if (action === "ack") {
    if (!hasScope(auth.scopes, "read")) {
      return json({ ok: false, error: "unauthorized", message: "token lacks read scope" }, 401);
    }
    try {
      const subscriber = await store.findByAgent(auth.label);
      if (!subscriber) {
        return json({ ok: false, error: "subscriber_not_found", message: errorMessage("subscriber_not_found") }, 404);
      }
      const items = parseAck(body.payload ?? {});
      const result = await store.ack(subscriber.id, items);
      return json({ ok: true, action: "ack", agent_key: subscriber.agent_key, ...result });
    } catch (e) {
      if (isDatabaseTimeout(e)) return timeoutJson();
      const code = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : "";
      if (!code) console.error("muse_alerts_ack_failed");
      const mapped = httpFor(code || "ack_rejected");
      return json(mapped.body, mapped.status);
    }
  }

  const requestKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(requestKey)) return json({ ok: false, error: "invalid_idempotency_key" }, 400);
  if (
    action !== "register_subscriber" &&
    action !== "update_subscriber" &&
    action !== "disable_subscriber" &&
    action !== "dispatch" &&
    action !== "route_inbox"
  ) {
    return json({ ok: false, error: "unknown_action" }, 400);
  }
  const admin = hasScope(auth.scopes, "alerts:admin");
  const dispatchScope = admin || hasScope(auth.scopes, "alerts:dispatch");
  if (action === "dispatch" ? !dispatchScope : !admin) {
    return json({
      ok: false,
      error: "unauthorized",
      message: action === "dispatch" ? "token lacks alerts:dispatch scope" : "token lacks alerts:admin scope",
    }, 401);
  }

  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const payloadHash = await sha256Hex(canonicalJson({ action, payload }));
  const { data: prior } = await db
    .from("muse_alert_requests")
    .select("action,payload_sha256,http_status,response")
    .eq("token_label", auth.label)
    .eq("request_key", requestKey)
    .maybeSingle();
  if (prior) {
    if (prior.action !== action || prior.payload_sha256 !== payloadHash) {
      return json({ ok: false, error: "idempotency_key_reused" }, 409);
    }
    return json({ ...(prior.response as Record<string, unknown>), idempotent_replay: true }, prior.http_status);
  }

  let status = 200;
  let responseBody: Record<string, unknown>;
  try {
    if (action === "register_subscriber") responseBody = await register(store, payload);
    else if (action === "update_subscriber") responseBody = await update(store, payload);
    else if (action === "disable_subscriber") responseBody = await disable(store, payload);
    else if (action === "route_inbox") {
      const result = await store.routeCodingInbox();
      responseBody = { ok: true, action, ...result };
    } else {
      const requested = typeof payload.limit === "number" ? payload.limit : 20;
      const limit = Math.min(Math.max(1, Math.trunc(requested)), 20);
      const key = await sealKey();
      if (!key) throw new Error("seal_key_missing");
      const result = await dispatchDue({ store, sealKey: key, limit });
      responseBody = { ok: true, action, ...result };
    }
  } catch (e) {
    if (isDatabaseTimeout(e)) return timeoutJson();
    const code = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : "";
    if (!code) console.error("muse_alerts_failed");
    const mapped = httpFor(code || "rejected");
    status = mapped.status;
    responseBody = mapped.body;
  }

  if (status !== 503) {
    await db.from("muse_alert_requests").insert({
      token_label: auth.label,
      request_key: requestKey,
      action,
      payload_sha256: payloadHash,
      http_status: status,
      response: responseBody,
    });
  }
  return json(responseBody, status);
}

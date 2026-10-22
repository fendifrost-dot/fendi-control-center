/**
 * muse-alerts — wake agents when a workboard post is addressed to them.
 *
 * GET  ?since=  pull posts addressed to the caller (scope: read)
 * GET  ?subscribers=1  list registry metadata (scope: alerts:admin)
 * POST register_subscriber | update_subscriber | disable_subscriber (alerts:admin)
 * POST dispatch (alerts:admin or alerts:dispatch)
 *
 * Webhook URLs and bearers are sealed before they are written. Responses
 * contain the host and a 4-character hint, never the URL or the key.
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createMuseAlertStore, type StoredSubscriber, type SubscriberWrite } from "../_shared/museAlertStore.ts";
import {
  canonicalJson,
  dispatchDue,
  errorMessage,
  keyHint,
  parseAgentKey,
  parseCursor,
  parseRegister,
  parseUpdate,
  pullAlerts,
  readSealKey,
  sealText,
  sha256Hex,
  subscriberFromToken,
  webhookEndpoint,
  type AlertRole,
  type SubscriberPublic,
} from "../_shared/museAlerts.ts";

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return req.headers.get("x-muse-token")?.trim() || null;
}

async function authenticate(db: SupabaseClient, token: string | null) {
  if (!token) return { ok: false as const, reason: "missing token" };
  if (token === SERVICE_KEY) return { ok: false as const, reason: "service-role key rejected" };
  if (ENV_TOKEN && timingSafeEqual(token, ENV_TOKEN)) {
    return { ok: true as const, label: "env-bootstrap", scopes: ["read"] };
  }
  const hash = await sha256Hex(token);
  const { data, error } = await db
    .from("muse_api_tokens")
    .select("id,label,scopes,expires_at,revoked_at")
    .eq("token_sha256", hash)
    .maybeSingle();
  if (error || !data) return { ok: false as const, reason: "unknown token" };
  if (data.revoked_at) return { ok: false as const, reason: "token revoked" };
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) {
    return { ok: false as const, reason: "token expired" };
  }
  await db.from("muse_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { ok: true as const, label: data.label as string, scopes: (data.scopes ?? []) as string[] };
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
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const auth = await authenticate(db, tokenFrom(req));
  if (!auth.ok) return json({ ok: false, error: "unauthorized", message: auth.reason }, 401);
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
        const code = e instanceof Error ? e.message : "subscribers_read_failed";
        const mapped = httpFor(code);
        return json(mapped.body, mapped.status);
      }
    }
    if (!hasScope(auth.scopes, "read")) {
      return json({ ok: false, error: "unauthorized", message: "token lacks read scope" }, 401);
    }
    let cursor;
    try {
      cursor = parseCursor(url.searchParams.get("since"), url.searchParams.get("since_id"));
    } catch (e) {
      const code = e instanceof Error ? e.message : "since_rejected";
      const mapped = httpFor(code);
      return json(mapped.body, mapped.status);
    }
    const requested = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), 100) : 50;
    try {
      const subscriber = subscriberFromToken(auth.label, await store.findByAgent(auth.label));
      const page = await pullAlerts({ store, subscriber, cursor, limit });
      return json({
        ok: true,
        agent_key: subscriber.agent_key,
        delivery: subscriber.delivery,
        since: cursor,
        next_cursor: page.next_cursor,
        row_count: page.data.length,
        data: page.data,
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : "events_read_failed";
      const mapped = httpFor(code);
      return json(mapped.body, mapped.status);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const requestKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(requestKey)) return json({ ok: false, error: "invalid_idempotency_key" }, 400);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const action = body.action;
  if (
    action !== "register_subscriber" &&
    action !== "update_subscriber" &&
    action !== "disable_subscriber" &&
    action !== "dispatch"
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
    else {
      const requested = typeof payload.limit === "number" ? payload.limit : 20;
      const limit = Math.min(Math.max(1, Math.trunc(requested)), 20);
      const key = await sealKey();
      if (!key) throw new Error("seal_key_missing");
      const result = await dispatchDue({ store, sealKey: key, limit });
      responseBody = { ok: true, action, ...result };
    }
  } catch (e) {
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
});

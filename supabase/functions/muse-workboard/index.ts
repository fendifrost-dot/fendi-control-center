import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isAction, boundedString, uuid, oneOf, type WorkboardAction } from "./contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-muse-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  return req.headers.get("x-muse-token")?.trim() || null;
}

async function authenticate(db: SupabaseClient, token: string | null) {
  if (!token) return { ok: false as const, reason: "missing token" };
  if (token === SERVICE_KEY) return { ok: false as const, reason: "service-role key rejected" };
  const hash = await sha256Hex(token);
  const { data, error } = await db.from("muse_api_tokens").select("id,label,scopes,expires_at,revoked_at").eq("token_sha256", hash).maybeSingle();
  if (error || !data) return { ok: false as const, reason: "unknown token" };
  if (data.revoked_at) return { ok: false as const, reason: "token revoked" };
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) return { ok: false as const, reason: "token expired" };
  if (!(data.scopes ?? []).includes("workboard:write")) return { ok: false as const, reason: "token lacks workboard:write scope" };
  await db.from("muse_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { ok: true as const, label: data.label as string };
}

function iso(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

async function execute(db: SupabaseClient, action: WorkboardAction, p: Record<string, unknown>, actor: string) {
  if (action === "create_mission") {
    const row = {
      domain_key: boundedString(p.domain_key, "domain_key", 100, true), title: boundedString(p.title, "title", 300, true),
      objective: boundedString(p.objective, "objective", 4000, true), business_outcome: boundedString(p.business_outcome, "business_outcome"),
      owner: boundedString(p.owner, "owner", 200) ?? "Muse", executive_sponsor: "Fendi",
      priority: oneOf(p.priority, "priority", ["P0","P1","P2","P3"], "P2"), status: oneOf(p.status, "status", ["PROPOSED","ACTIVE","PAUSED"], "PROPOSED"),
      metric: boundedString(p.metric, "metric"), baseline: boundedString(p.baseline, "baseline"), target: boundedString(p.target, "target"),
      review_at: iso(p.review_at, "review_at"), source_ref: boundedString(p.source_ref, "source_ref"), created_by: actor,
      notes: boundedString(p.notes, "notes"),
    };
    return await db.from("muse_missions").insert(row).select("*").single();
  }
  if (action === "create_improvement") {
    const row = {
      domain_key: boundedString(p.domain_key, "domain_key", 100, true), problem: boundedString(p.problem, "problem", 4000, true),
      intervention: boundedString(p.intervention, "intervention", 4000, true), metric: boundedString(p.metric, "metric", 1000, true),
      baseline: boundedString(p.baseline, "baseline"), expected_result: boundedString(p.expected_result, "expected_result"), owner: "Muse",
      status: "PROPOSED", verdict: "PENDING", verification_state: "CLAIMED", improvement_date: boundedString(p.improvement_date, "improvement_date", 10),
      function_name: boundedString(p.function_name, "function_name"), observation: boundedString(p.observation, "observation"), hypothesis: boundedString(p.hypothesis, "hypothesis"),
      confidence: p.confidence ? oneOf(p.confidence, "confidence", ["HIGH","MEDIUM","LOW"]) : null,
      risk: boundedString(p.risk, "risk"), reversible: typeof p.reversible === "boolean" ? p.reversible : null,
      priority: p.priority ? oneOf(p.priority, "priority", ["P0","P1","P2","P3"]) : "P2",
      recommended_executor: boundedString(p.recommended_executor, "recommended_executor", 200), selected_by: actor,
      mission_id: uuid(p.mission_id, "mission_id", false), definition_of_done: boundedString(p.definition_of_done, "definition_of_done"),
      verification_requirement: boundedString(p.verification_requirement, "verification_requirement"),
      owner_attention: p.owner_attention ? oneOf(p.owner_attention, "owner_attention", ["NONE","INFORM","APPROVAL","DECISION","DIRECT_INVOLVEMENT"]) : "NONE",
      expected_impact: boundedString(p.expected_impact, "expected_impact"), observe_only_reason: boundedString(p.observe_only_reason, "observe_only_reason"),
      review_at: iso(p.review_at, "review_at"), source_ref: boundedString(p.source_ref, "source_ref"), notes: boundedString(p.notes, "notes"),
    };
    return await db.from("muse_improvements").insert(row).select("*").single();
  }
  if (action === "create_task") {
    const row = {
      improvement_id: uuid(p.improvement_id, "improvement_id"), domain_key: boundedString(p.domain_key, "domain_key", 100, true),
      title: boundedString(p.title, "title", 300, true), executor: boundedString(p.executor, "executor", 200, true), assigning_agent: actor,
      objective: boundedString(p.objective, "objective"), instructions: boundedString(p.instructions, "instructions", 8000),
      expected_artifact: boundedString(p.expected_artifact, "expected_artifact"), definition_of_done: boundedString(p.definition_of_done, "definition_of_done"),
      priority: oneOf(p.priority, "priority", ["P0","P1","P2","P3"], "P2"), state: "ASSIGNED", verification_state: "CLAIMED",
      due_at: iso(p.due_at, "due_at"), source_ref: boundedString(p.source_ref, "source_ref"),
    };
    return await db.from("muse_improvement_tasks").insert(row).select("*").single();
  }
  if (action === "append_update") {
    const row = {
      domain_key: boundedString(p.domain_key, "domain_key", 100), mission_id: uuid(p.mission_id, "mission_id", false),
      improvement_id: uuid(p.improvement_id, "improvement_id", false), task_id: uuid(p.task_id, "task_id", false), actor,
      update_type: oneOf(p.update_type, "update_type", ["NOTE","ASSIGNMENT","STATUS","BLOCKER","EVIDENCE","DECISION","MEASUREMENT"], "NOTE"),
      message: boundedString(p.message, "message", 8000, true), evidence_ref: boundedString(p.evidence_ref, "evidence_ref"),
    };
    if (!row.mission_id && !row.improvement_id && !row.task_id) throw new Error("one parent id is required");
    return await db.from("muse_work_updates").insert(row).select("*").single();
  }
  if (action === "record_measurement") {
    const row = {
      improvement_id: uuid(p.improvement_id, "improvement_id"), measurement_type: oneOf(p.measurement_type, "measurement_type", ["BASELINE","IMMEDIATE","DAY_7","DAY_30","CUSTOM"]),
      metric: boundedString(p.metric, "metric", 1000, true), value_text: boundedString(p.value_text, "value_text"),
      value_numeric: typeof p.value_numeric === "number" ? p.value_numeric : null, unit: boundedString(p.unit, "unit", 100), delta_text: boundedString(p.delta_text, "delta_text"),
      financial_impact: typeof p.financial_impact === "number" ? p.financial_impact : null, time_saved_minutes: typeof p.time_saved_minutes === "number" ? p.time_saved_minutes : null,
      unintended_consequences: boundedString(p.unintended_consequences, "unintended_consequences"), evidence_ref: boundedString(p.evidence_ref, "evidence_ref"),
      verification_state: oneOf(p.verification_state, "verification_state", ["CLAIMED","ARTIFACT_VERIFIED","SYSTEM_VERIFIED","LIVE_VERIFIED"], "CLAIMED"), notes: boundedString(p.notes, "notes"),
    };
    if (row.value_text === null && row.value_numeric === null) throw new Error("value_text or value_numeric is required");
    return await db.from("muse_improvement_measurements").insert(row).select("*").single();
  }
  if (action === "update_task_state") {
    const id = uuid(p.task_id, "task_id")!;
    const state = oneOf(p.state, "state", ["ASSIGNED","IN_PROGRESS","WAITING","BLOCKED","IMPLEMENTED","VERIFICATION","COMPLETE","CANCELLED"]);
    const patch: Record<string, unknown> = { state, blocker: boundedString(p.blocker, "blocker") };
    if (["IMPLEMENTED","VERIFICATION","COMPLETE"].includes(state)) patch.claimed_completed_at = new Date().toISOString();
    return await db.from("muse_improvement_tasks").update(patch).eq("id", id).select("*").single();
  }
  if (action === "update_task_verification") {
    const id = uuid(p.task_id, "task_id")!;
    const verification_state = oneOf(p.verification_state, "verification_state", ["CLAIMED","ARTIFACT_VERIFIED","SYSTEM_VERIFIED","LIVE_VERIFIED"]);
    return await db.from("muse_improvement_tasks").update({ verification_state }).eq("id", id).select("*").single();
  }
  const id = uuid(p.improvement_id, "improvement_id")!;
  const status = oneOf(p.status, "status", ["PROPOSED","RUNNING","MEASURED","CLOSED"]);
  const verdict = p.verdict ? oneOf(p.verdict, "verdict", ["PENDING","KEEP","REVISE","REVERSE"]) : undefined;
  const patch: Record<string, unknown> = { status };
  if (verdict) patch.verdict = verdict;
  if (p.actual_result !== undefined) patch.actual_result = boundedString(p.actual_result, "actual_result");
  return await db.from("muse_improvements").update(patch).eq("id", id).select("*").single();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const auth = await authenticate(db, tokenFrom(req));
  if (!auth.ok) return json({ error: "unauthorized", message: auth.reason }, 401);
  const requestKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(requestKey)) return json({ error: "invalid_idempotency_key" }, 400);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (!isAction(body.action)) return json({ error: "unknown_action" }, 400);

  const { data: prior } = await db.from("muse_workboard_requests").select("action,http_status,response").eq("token_label", auth.label).eq("request_key", requestKey).maybeSingle();
  if (prior) {
    if (prior.action !== body.action) return json({ error: "idempotency_key_reused_for_different_action" }, 409);
    return json({ ...(prior.response as Record<string, unknown>), idempotent_replay: true }, prior.http_status);
  }

  let payload: Record<string, unknown>;
  let status = 200;
  try {
    const result = await execute(db, body.action, (body.payload ?? {}) as Record<string, unknown>, auth.label);
    if (result.error) throw new Error(result.error.message);
    payload = { ok: true, action: body.action, data: result.data };
  } catch (e) {
    status = 400;
    payload = { ok: false, action: body.action, error: e instanceof Error ? e.message : "write failed" };
  }

  await db.from("muse_workboard_requests").insert({ token_label: auth.label, request_key: requestKey, action: body.action, http_status: status, response: payload });
  return json(payload, status);
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "partial_success",
  "dead_letter",
  "chunk_processing_failed",
]);

const VALID_FINAL_STATUSES = new Set([
  "completed",
  "partial_success",
  "chunk_processing_failed",
]);

/** Constant-time comparison to prevent timing attacks */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const hub = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const jobId = body.job_id as string;
  const callbackToken = body.callback_token as string;

  if (!jobId || !callbackToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "job_id and callback_token are required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Load job
  const { data: job, error: loadErr } = await hub
    .from("statement_chunk_jobs")
    .select("id, status, callback_token_hash, processing_mode, extracted_payload")
    .eq("id", jobId)
    .maybeSingle();

  if (loadErr || !job) {
    return new Response(
      JSON.stringify({ ok: false, error: "job not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Validate callback token
  if (!job.callback_token_hash) {
    return new Response(
      JSON.stringify({ ok: false, error: "no callback token configured for this job" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Hash the provided token and compare
  const providedHashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(callbackToken),
  );
  const providedHash = Array.from(new Uint8Array(providedHashBuf), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  if (!constantTimeEqual(providedHash, job.callback_token_hash)) {
    console.warn(`[ext-callback] invalid token for job=${jobId}`);
    return new Response(
      JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Idempotency: if already terminal, return success no-op
  if (TERMINAL_STATUSES.has(job.status)) {
    console.log(`[ext-callback] job=${jobId} already terminal (${job.status}), no-op`);
    return new Response(
      JSON.stringify({ ok: true, noop: true, status: job.status }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Validate final status
  const finalStatus = body.status as string;
  if (!finalStatus || !VALID_FINAL_STATUSES.has(finalStatus)) {
    return new Response(
      JSON.stringify({ ok: false, error: `invalid status: ${finalStatus}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Extract payload fields
  const chunkCount = typeof body.chunk_count === "number" ? body.chunk_count : null;
  const pagesTotal = typeof body.pages_total === "number" ? body.pages_total : null;
  const pagesProcessed = typeof body.pages_processed === "number" ? body.pages_processed : null;
  const pagesFailed = typeof body.pages_failed === "number" ? body.pages_failed : null;
  const transactionsExtracted = typeof body.transactions_extracted === "number" ? body.transactions_extracted : null;
  const reasonCodes = Array.isArray(body.reason_codes) ? body.reason_codes : [];
  const warningFlags = Array.isArray(body.warning_flags) ? body.warning_flags : [];
  const processorVersion = typeof body.processor_version === "string" ? body.processor_version : null;

  // Process extracted_payload with HARD RULE: zero income from statements
  let extractedPayload = body.extracted_payload as Record<string, unknown> | null;
  const enforcedReasonCodes = [...reasonCodes];

  if (extractedPayload) {
    // Enforce: income_items MUST be empty
    const incomeItems = extractedPayload.income_items;
    if (Array.isArray(incomeItems) && incomeItems.length > 0) {
      console.warn(
        `[ext-callback] job=${jobId}: wiping ${incomeItems.length} income_items (hard rule: zero income from statements)`,
      );
      extractedPayload = {
        ...extractedPayload,
        income_items: [],
      };
      enforcedReasonCodes.push("income_items_wiped_by_callback_guard");
    }

    // Ensure income_items exists as empty array
    if (!Array.isArray(extractedPayload.income_items)) {
      extractedPayload.income_items = [];
    }
  }

  const now = new Date().toISOString();

  // Update job with callback results
  const { error: updateErr } = await hub
    .from("statement_chunk_jobs")
    .update({
      status: finalStatus,
      chunk_count: chunkCount,
      pages_total: pagesTotal,
      pages_processed: pagesProcessed,
      pages_failed: pagesFailed,
      transactions_extracted: transactionsExtracted,
      extracted_payload: extractedPayload,
      reason_codes: enforcedReasonCodes,
      warning_flags: warningFlags,
      external_status: finalStatus === "chunk_processing_failed" ? "failed" : "succeeded",
      callback_received_at: now,
      processor_version: processorVersion,
      finalized_by: "external_callback",
      completed_at: now,
      updated_at: now,
    })
    .eq("id", jobId);

  if (updateErr) {
    console.error(`[ext-callback] update failed job=${jobId}: ${updateErr.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: updateErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log(`[ext-callback] job=${jobId} finalized: status=${finalStatus} tx=${transactionsExtracted}`);

  // Resume any workflow_runs waiting on this job
  try {
    const { data: waitingRuns } = await hub
      .from("workflow_runs")
      .select("id, locked_state")
      .eq("status", "waiting_async");

    for (const wr of waitingRuns ?? []) {
      const ls = wr.locked_state as Record<string, unknown> | null;
      const ids = (ls?.statement_job_ids ?? []) as string[];
      if (ids.includes(jobId)) {
        console.log(`[ext-callback] resuming workflow_run=${wr.id} after job=${jobId}`);
        const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/workflow-runner`;
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ run_id: wr.id }),
        }).catch((e) => console.error(`[ext-callback] resume failed for run=${wr.id}: ${e}`));
      }
    }
  } catch (resumeErr) {
    console.error(`[ext-callback] workflow resume scan failed: ${resumeErr}`);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      job_id: jobId,
      status: finalStatus,
      finalized_by: "external_callback",
      transactions_extracted: transactionsExtracted,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

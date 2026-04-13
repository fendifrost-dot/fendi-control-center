import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EDGE_SAFE_BYTE_LIMIT = Number(Deno.env.get("EDGE_SAFE_BYTE_LIMIT") || 80_000_000);
const MAX_EXTERNAL_ATTEMPTS = 3;

/** Generate a random callback token + its SHA-256 hash */
async function generateCallbackToken(): Promise<{ token: string; hash: string }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const token = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, "0")).join("");
  return { token, hash };
}

/** Exponential backoff: 2min, 8min, 32min */
function nextRetryTime(attempts: number): string {
  const delayMs = Math.min(2 * Math.pow(4, attempts) * 60_000, 120 * 60_000);
  return new Date(Date.now() + delayMs).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const hub = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const externalUrl = Deno.env.get("EXTERNAL_STATEMENT_PROCESSOR_URL");
  const externalAuth = Deno.env.get("EXTERNAL_STATEMENT_PROCESSOR_AUTH_TOKEN");
  const callbackSecret = Deno.env.get("EXTERNAL_CALLBACK_SHARED_SECRET");

  if (!externalUrl || !callbackSecret) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "external processor not configured (missing EXTERNAL_STATEMENT_PROCESSOR_URL or EXTERNAL_CALLBACK_SHARED_SECRET)",
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let limit = 5;
  try {
    const body = await req.json();
    if (typeof body?.limit === "number" && body.limit > 0) limit = Math.min(body.limit, 10);
  } catch { /* default */ }

  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/statement-external-callback`;

  // Select eligible jobs:
  // 1. Jobs with reason too_large_for_edge_processing and not yet externally dispatched
  // 2. Or jobs whose external dispatch previously failed and are retryable
  const now = new Date().toISOString();

  // Query 1: New oversized jobs not yet queued externally
  const { data: newJobs } = await hub
    .from("statement_chunk_jobs")
    .select("id, client_id, tax_year, source_storage_bucket, source_storage_path, source_bytes, chunk_size_pages, external_attempts, file_size_bytes")
    .in("status", ["requires_async_processing", "chunk_processing_failed"])
    .is("external_status", null)
    .gt("source_bytes", EDGE_SAFE_BYTE_LIMIT)
    .eq("prep_status", "ready")
    .lt("external_attempts", MAX_EXTERNAL_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(limit);

  // Query 2: Previously failed external jobs ready for retry
  const { data: retryJobs } = await hub
    .from("statement_chunk_jobs")
    .select("id, client_id, tax_year, source_storage_bucket, source_storage_path, source_bytes, chunk_size_pages, external_attempts, file_size_bytes")
    .eq("external_status", "failed")
    .lt("external_attempts", MAX_EXTERNAL_ATTEMPTS)
    .lte("next_retry_at", now)
    .neq("status", "dead_letter")
    .order("created_at", { ascending: true })
    .limit(limit);

  const candidates = [...(newJobs || []), ...(retryJobs || [])];
  // Dedupe by id
  const seen = new Set<string>();
  const jobs = candidates.filter((j) => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  }).slice(0, limit);

  if (jobs.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, picked: 0, queued: 0, started: 0, failed_to_start: 0, dead_lettered: 0, job_ids: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let started = 0;
  let failedToStart = 0;
  let deadLettered = 0;
  const jobIds: string[] = [];

  for (const job of jobs) {
    const newAttempts = (job.external_attempts ?? 0) + 1;

    // Generate callback token
    const { token, hash } = await generateCallbackToken();

    // Update job: mark as external + queued
    const { error: updateErr } = await hub
      .from("statement_chunk_jobs")
      .update({
        processing_mode: "external",
        external_status: "queued",
        external_attempts: newAttempts,
        external_endpoint: externalUrl,
        callback_token_hash: hash,
        status: "requires_async_processing",
        updated_at: now,
      })
      .eq("id", job.id);

    if (updateErr) {
      console.error(`[ext-dispatch] update failed job=${job.id}: ${updateErr.message}`);
      failedToStart++;
      continue;
    }

    // Call external processor
    try {
      const payload = {
        job_id: job.id,
        client_id: job.client_id,
        tax_year: job.tax_year,
        source_storage_bucket: job.source_storage_bucket,
        source_storage_path: job.source_storage_path,
        source_bytes: job.source_bytes ?? job.file_size_bytes,
        chunk_size_pages: job.chunk_size_pages ?? 5,
        callback_url: callbackUrl,
        callback_token: token,
      };

      const resp = await fetch(externalUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(externalAuth ? { Authorization: `Bearer ${externalAuth}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 500)}`);
      }

      let externalJobId: string | null = null;
      try {
        const respBody = await resp.json();
        externalJobId = respBody?.job_id || respBody?.external_job_id || null;
      } catch { /* no body */ }

      // Mark running
      await hub.from("statement_chunk_jobs").update({
        external_status: "running",
        external_job_id: externalJobId,
        external_provider: "cloud_run",
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);

      started++;
      jobIds.push(job.id);
      console.log(`[ext-dispatch] started external processing job=${job.id} extId=${externalJobId}`);

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ext-dispatch] invoke failed job=${job.id}: ${msg}`);

      if (newAttempts >= MAX_EXTERNAL_ATTEMPTS) {
        // Dead-letter
        await hub.from("statement_chunk_jobs").update({
          status: "dead_letter",
          external_status: "failed",
          external_last_error: msg.slice(0, 2000),
          finalized_by: "dispatcher_guard",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        deadLettered++;
        console.log(`[ext-dispatch] dead-lettered job=${job.id} after ${newAttempts} attempts`);
      } else {
        await hub.from("statement_chunk_jobs").update({
          external_status: "failed",
          external_last_error: msg.slice(0, 2000),
          next_retry_at: nextRetryTime(newAttempts),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        failedToStart++;
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      picked: jobs.length,
      queued: jobs.length,
      started,
      failed_to_start: failedToStart,
      dead_lettered: deadLettered,
      job_ids: jobIds,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

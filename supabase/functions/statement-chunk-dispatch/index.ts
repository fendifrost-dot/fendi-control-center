import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const hub = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let limit = 5;
  try {
    const body = await req.json();
    if (typeof body?.limit === "number" && body.limit > 0) limit = Math.min(body.limit, 20);
  } catch { /* default */ }

  // 1. Dead-letter: mark jobs that have exhausted attempts
  const { data: deadRows } = await hub
    .from("statement_chunk_jobs")
    .select("id")
    .eq("status", "requires_async_processing")
    .gte("attempts", 3);

  if (deadRows && deadRows.length > 0) {
    for (const row of deadRows) {
      await hub
        .from("statement_chunk_jobs")
        .update({
          status: "dead_letter",
          last_error: "max_attempts_exceeded",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
    console.log(`[dispatch] Marked ${deadRows.length} jobs as dead_letter`);
  }

  // 2. Select oldest claimable jobs
  const { data: pending, error: selErr } = await hub
    .from("statement_chunk_jobs")
    .select("id, client_id, tax_year, attempts, prep_status, source_storage_bucket, source_storage_path, processing_mode, source_bytes, file_size_bytes")
    .eq("status", "requires_async_processing")
    .eq("processing_mode", "edge")
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (selErr) {
    console.error("[dispatch] select error:", selErr.message);
    return new Response(
      JSON.stringify({ ok: false, error: selErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!pending || pending.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, picked: 0, prep_started: 0, prep_failed: 0, worker_started: 0, failed_to_start: 0, job_ids: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const now = new Date().toISOString();
  let prepStarted = 0;
  let prepFailed = 0;
  let workerStarted = 0;
  let failedToStart = 0;
  const jobIds: string[] = [];

  const baseUrl = Deno.env.get("SUPABASE_URL")!;
  const prepUrl = `${baseUrl}/functions/v1/statement-source-prep`;
  const workerUrl = `${baseUrl}/functions/v1/statement-chunk-worker`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  for (const job of pending) {
    const needsPrep = job.prep_status !== "ready";

    // Increment attempts once per dispatch cycle
    const { error: claimErr } = await hub
      .from("statement_chunk_jobs")
      .update({
        attempts: (job.attempts ?? 0) + 1,
        claimed_at: now,
        updated_at: now,
        // Only set processing_chunked if prep is ready (going straight to worker)
        ...(needsPrep ? {} : { status: "processing_chunked" }),
      })
      .eq("id", job.id)
      .eq("status", "requires_async_processing");

    if (claimErr) {
      console.error(`[dispatch] claim failed job=${job.id}: ${claimErr.message}`);
      failedToStart++;
      continue;
    }

    jobIds.push(job.id);

    if (needsPrep) {
      // Invoke prep function (fire-and-forget)
      try {
        fetch(prepUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            job_id: job.id,
            client_id: job.client_id,
            tax_year: job.tax_year,
          }),
        }).catch((e) => {
          console.error(`[dispatch] prep fetch failed job=${job.id}: ${e}`);
        });
        prepStarted++;
        console.log(`[dispatch] fired prep for job=${job.id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[dispatch] prep invoke failed job=${job.id}: ${msg}`);
        await hub.from("statement_chunk_jobs").update({
          status: "chunk_processing_failed",
          last_error: `prep_invoke_failed:${msg.slice(0, 500)}`,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        prepFailed++;
      }
    } else {
      // Prep is ready — invoke worker directly (fire-and-forget)
      try {
        fetch(workerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            job_id: job.id,
            client_id: job.client_id,
            tax_year: job.tax_year,
          }),
        }).catch((e) => {
          console.error(`[dispatch] worker fetch failed job=${job.id}: ${e}`);
        });
        workerStarted++;
        console.log(`[dispatch] fired worker for job=${job.id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[dispatch] worker invoke failed job=${job.id}: ${msg}`);
        await hub.from("statement_chunk_jobs").update({
          status: "chunk_processing_failed",
          last_error: `dispatch_invoke_failed:${msg.slice(0, 500)}`,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        failedToStart++;
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      picked: pending.length,
      prep_started: prepStarted,
      prep_failed: prepFailed,
      worker_started: workerStarted,
      failed_to_start: failedToStart,
      job_ids: jobIds,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

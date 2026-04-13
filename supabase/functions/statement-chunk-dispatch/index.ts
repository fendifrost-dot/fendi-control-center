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
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
    console.log(`[dispatch] Marked ${deadRows.length} jobs as dead_letter`);
  }

  // 2. Select oldest claimable jobs
  const { data: pending, error: selErr } = await hub
    .from("statement_chunk_jobs")
    .select("id, client_id, tax_year, attempts")
    .eq("status", "requires_async_processing")
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
      JSON.stringify({ ok: true, picked: 0, started: 0, failed_to_start: 0, job_ids: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const now = new Date().toISOString();
  let started = 0;
  let failedToStart = 0;
  const jobIds: string[] = [];

  const workerUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/statement-chunk-worker`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  for (const job of pending) {
    // 3. Atomically claim
    const { error: claimErr } = await hub
      .from("statement_chunk_jobs")
      .update({
        status: "processing_chunked",
        attempts: (job.attempts ?? 0) + 1,
        claimed_at: now,
        updated_at: now,
      })
      .eq("id", job.id)
      .eq("status", "requires_async_processing");

    if (claimErr) {
      console.error(`[dispatch] claim failed job=${job.id}: ${claimErr.message}`);
      failedToStart++;
      continue;
    }

    // 4. Invoke worker (true fire-and-forget: don't await response)
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
        console.error(`[dispatch] background fetch failed job=${job.id}: ${e}`);
      });

      started++;
      jobIds.push(job.id);
      console.log(`[dispatch] fired worker for job=${job.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[dispatch] invoke failed job=${job.id}: ${msg}`);
      await hub
        .from("statement_chunk_jobs")
        .update({
          status: "chunk_processing_failed",
          last_error: `dispatch_invoke_failed:${msg.slice(0, 500)}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      failedToStart++;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      picked: pending.length,
      started,
      failed_to_start: failedToStart,
      job_ids: jobIds,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

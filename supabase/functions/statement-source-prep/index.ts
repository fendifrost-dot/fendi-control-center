import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { downloadFileRaw } from "../_shared/googleDriveRead.ts";

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

  let jobId: string;
  let clientId: string;
  let taxYear: number;
  try {
    const body = await req.json();
    jobId = body.job_id;
    clientId = body.client_id;
    taxYear = body.tax_year;
    if (!jobId || !clientId || !taxYear) throw new Error("missing fields");
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: `bad input: ${e instanceof Error ? e.message : e}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log(`[source-prep] starting job=${jobId} client=${clientId} year=${taxYear}`);

  const { data: job, error: loadErr } = await hub
    .from("statement_chunk_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (loadErr || !job) {
    return new Response(
      JSON.stringify({ ok: false, error: loadErr?.message ?? "job not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Idempotency: already prepped
  if (job.prep_status === "ready") {
    console.log(`[source-prep] job=${jobId} already ready, no-op`);
    return new Response(
      JSON.stringify({ ok: true, noop: true, prep_status: "ready", source_storage_path: job.source_storage_path }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Skip if job is already terminal
  const TERMINAL = new Set(["completed", "partial_success", "dead_letter", "chunk_processing_failed"]);
  if (TERMINAL.has(job.status)) {
    console.log(`[source-prep] job=${jobId} already terminal (${job.status}), skipping prep`);
    return new Response(
      JSON.stringify({ ok: true, noop: true, status: job.status }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const bucket = "tax-chunk-source";
  const storagePath = `chunk-jobs/${clientId}/${taxYear}/${jobId}.pdf`;
  const now = new Date().toISOString();

  // Mark copying
  await hub.from("statement_chunk_jobs").update({
    prep_status: "copying",
    prep_started_at: now,
    updated_at: now,
  }).eq("id", jobId);

  try {
    // Determine source file ID: prefer source_drive_file_id, fallback to file_id for drive source
    const driveFileId = job.source_drive_file_id || (job.source_type === "drive" ? job.file_id : null);
    if (!driveFileId) {
      throw new Error("no drive file ID available for prep");
    }

    // Download raw bytes from Drive
    const { bytes } = await downloadFileRaw(driveFileId, "application/pdf");
    console.log(`[source-prep] downloaded ${bytes.length} bytes from Drive for job=${jobId}`);

    // Upload to Supabase Storage
    const { error: uploadErr } = await hub.storage
      .from(bucket)
      .upload(storagePath, bytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadErr) {
      throw new Error(`storage upload failed: ${uploadErr.message}`);
    }

    // Mark ready
    const completedAt = new Date().toISOString();
    await hub.from("statement_chunk_jobs").update({
      source_storage_bucket: bucket,
      source_storage_path: storagePath,
      source_bytes: bytes.length,
      prep_status: "ready",
      prep_completed_at: completedAt,
      updated_at: completedAt,
    }).eq("id", jobId);

    console.log(`[source-prep] job=${jobId} prep complete, ${bytes.length} bytes staged to ${bucket}/${storagePath}`);

    return new Response(
      JSON.stringify({
        ok: true,
        job_id: jobId,
        prep_status: "ready",
        source_storage_bucket: bucket,
        source_storage_path: storagePath,
        source_bytes: bytes.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[source-prep] fatal error job=${jobId}: ${msg}`);

    const failedAt = new Date().toISOString();
    await hub.from("statement_chunk_jobs").update({
      prep_status: "prep_failed",
      prep_error: msg.slice(0, 2000),
      status: "chunk_processing_failed",
      last_error: `prep_failed:${msg.slice(0, 500)}`,
      completed_at: failedAt,
      updated_at: failedAt,
    }).eq("id", jobId);

    return new Response(
      JSON.stringify({ ok: false, job_id: jobId, prep_status: "prep_failed", error: msg.slice(0, 1000) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

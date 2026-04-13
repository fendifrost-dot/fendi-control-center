import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { splitPdfIntoPages, isScannedPage } from "../_shared/pdfSplitter.ts";
import { chunkPages } from "../_shared/chunker.ts";
import { ocrPage } from "../_shared/ocr.ts";
import { extractStatementChunk } from "../_shared/geminiParser.ts";
import { mergeChunkResults, type StatementTx } from "../_shared/statementMerger.ts";
import { downloadFileRaw } from "../_shared/googleDriveRead.ts";

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

/** Max bytes we'll attempt to parse in-memory with pdf-lib (~80MB safety margin) */
const EDGE_SAFE_BYTE_LIMIT = 80_000_000;

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
    if (!jobId || !clientId || !taxYear) throw new Error("missing required fields");
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: `bad input: ${e instanceof Error ? e.message : e}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log(`[chunk-worker] starting job=${jobId} client=${clientId} year=${taxYear}`);

  // Load job
  const { data: job, error: loadErr } = await hub
    .from("statement_chunk_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("client_id", clientId)
    .eq("tax_year", taxYear)
    .maybeSingle();

  if (loadErr || !job) {
    const msg = loadErr?.message ?? "job not found";
    console.error(`[chunk-worker] load failed: ${msg}`);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Idempotency: skip terminal jobs
  if (TERMINAL_STATUSES.has(job.status)) {
    console.log(`[chunk-worker] job=${jobId} already terminal (${job.status}), skipping`);
    return new Response(
      JSON.stringify({ ok: true, noop: true, status: job.status }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (job.status !== "processing_chunked") {
    console.log(`[chunk-worker] job=${jobId} unexpected status=${job.status}, skipping`);
    return new Response(
      JSON.stringify({ ok: false, error: `unexpected status: ${job.status}` }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Mark started
  await hub
    .from("statement_chunk_jobs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", jobId);

  const reasonCodes: string[] = [];
  const warningFlags: string[] = [];

  try {
    // Download source file — prefer staged storage, fallback to drive
    let pdfBytes: Uint8Array;

    if (job.source_storage_bucket && job.source_storage_path) {
      // Download from Supabase Storage (pre-staged)
      console.log(`[chunk-worker] downloading from storage: ${job.source_storage_bucket}/${job.source_storage_path}`);
      const { data: blob, error: dlErr } = await hub.storage
        .from(job.source_storage_bucket)
        .download(job.source_storage_path);
      if (dlErr || !blob) throw new Error(`storage download failed: ${dlErr?.message ?? "no data"}`);
      pdfBytes = new Uint8Array(await blob.arrayBuffer());
    } else if (job.source_type === "storage") {
      // Legacy storage mode
      const { data: blob, error: dlErr } = await hub.storage
        .from("tax-source-documents")
        .download(job.file_id);
      if (dlErr || !blob) throw new Error(`storage download failed: ${dlErr?.message ?? "no data"}`);
      pdfBytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      // Download from Google Drive (raw bytes)
      const driveResult = await downloadFileRaw(job.source_drive_file_id || job.file_id, "application/pdf");
      pdfBytes = driveResult.bytes;
    }

    console.log(`[chunk-worker] downloaded ${pdfBytes.length} bytes for job=${jobId}`);

    // SIZE-CAP SAFETY: reject files too large for edge pdf-lib parsing
    if (pdfBytes.length > EDGE_SAFE_BYTE_LIMIT) {
      const msg = `file ${pdfBytes.length} bytes exceeds edge-safe limit ${EDGE_SAFE_BYTE_LIMIT}`;
      console.error(`[chunk-worker] ${msg}`);
      reasonCodes.push("too_large_for_edge_processing");

      await hub.from("statement_chunk_jobs").update({
        status: "chunk_processing_failed",
        last_error: msg,
        reason_codes: [...reasonCodes],
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);

      return new Response(
        JSON.stringify({ ok: false, job_id: jobId, status: "chunk_processing_failed", error: msg }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Split into pages
    const pages = await splitPdfIntoPages(pdfBytes);
    const pagesTotal = pages.length;
    console.log(`[chunk-worker] split into ${pagesTotal} pages`);

    // Chunk at 5 pages/chunk
    const chunks = chunkPages(pages, job.chunk_size_pages ?? 5);
    const chunkCount = chunks.length;

    let pagesProcessed = 0;
    let pagesFailed = 0;
    const allChunkTx: StatementTx[][] = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      let chunkSuccess = false;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // OCR scanned pages
          const textParts: string[] = [];
          for (const page of chunk.pages) {
            if (isScannedPage(page)) {
              const ocrText = await ocrPage(page);
              page.text = ocrText;
              textParts.push(ocrText);
            } else {
              textParts.push(page.text ?? "");
            }
          }

          const combinedText = textParts.join("\n\n---PAGE BREAK---\n\n");
          if (combinedText.trim().length < 20) {
            reasonCodes.push(`chunk_${ci}_empty_text`);
            pagesFailed += chunk.pages.length;
            chunkSuccess = true; // not retriable
            break;
          }

          const result = await extractStatementChunk(combinedText);
          allChunkTx.push(
            result.transactions.map((t) => ({
              date: t.date,
              description: t.description,
              amount: t.amount,
            })),
          );
          pagesProcessed += chunk.pages.length;
          chunkSuccess = true;
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt === 0) {
            console.warn(`[chunk-worker] chunk ${ci} attempt 1 failed, retrying: ${msg}`);
            warningFlags.push(`chunk_${ci}_retry`);
          } else {
            console.error(`[chunk-worker] chunk ${ci} failed after retry: ${msg}`);
            reasonCodes.push(`chunk_${ci}_failed:${msg.slice(0, 200)}`);
            pagesFailed += chunk.pages.length;
          }
        }
      }

      if (!chunkSuccess) {
        pagesFailed += chunk.pages.length;
      }
    }

    // Merge + dedupe
    const merged = mergeChunkResults(allChunkTx);
    const txCount = merged.length;

    console.log(`[chunk-worker] job=${jobId} extracted ${txCount} transactions, pagesProcessed=${pagesProcessed}, pagesFailed=${pagesFailed}`);

    // Build expense items (NEVER income)
    const expenseItems = merged.map((t) => ({
      category: "other",
      description: t.description,
      amount: Math.abs(t.amount),
      date: t.date,
    }));

    // Determine final status
    let finalStatus: string;
    if (txCount === 0) {
      finalStatus = "chunk_processing_failed";
      reasonCodes.push("zero_transactions_extracted");
    } else if (pagesFailed > 0) {
      finalStatus = "partial_success";
    } else {
      finalStatus = "completed";
    }

    // Check dead letter
    if ((job.attempts ?? 0) >= 3 && finalStatus === "chunk_processing_failed") {
      finalStatus = "dead_letter";
    }

    // Persist
    await hub
      .from("statement_chunk_jobs")
      .update({
        status: finalStatus,
        chunk_count: chunkCount,
        pages_total: pagesTotal,
        pages_processed: pagesProcessed,
        pages_failed: pagesFailed,
        transactions_extracted: txCount,
        extracted_payload: {
          expense_items: expenseItems,
          income_items: [], // NEVER income from statements
          merge_stats: {
            raw_count: allChunkTx.reduce((s, a) => s + a.length, 0),
            deduped_count: txCount,
          },
        },
        reason_codes: reasonCodes,
        warning_flags: warningFlags,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    console.log(`[chunk-worker] job=${jobId} finished with status=${finalStatus}`);

    return new Response(
      JSON.stringify({
        ok: true,
        job_id: jobId,
        status: finalStatus,
        chunk_count: chunkCount,
        pages_total: pagesTotal,
        pages_processed: pagesProcessed,
        pages_failed: pagesFailed,
        transactions_extracted: txCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[chunk-worker] fatal error job=${jobId}: ${msg}`);

    // Check for memory-related errors
    const isMemoryError = msg.includes("memory") || msg.includes("Memory") || msg.includes("heap");
    if (isMemoryError) {
      reasonCodes.push("memory_limit_exceeded");
    }

    let finalStatus = "chunk_processing_failed";
    if ((job.attempts ?? 0) >= 3) finalStatus = "dead_letter";

    await hub
      .from("statement_chunk_jobs")
      .update({
        status: finalStatus,
        last_error: msg.slice(0, 2000),
        reason_codes: [...reasonCodes, `fatal:${msg.slice(0, 500)}`],
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return new Response(
      JSON.stringify({ ok: false, job_id: jobId, status: finalStatus, error: msg.slice(0, 1000) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } finally {
    // FINAL GUARD: ensure job is never stuck in processing_chunked
    try {
      const { data: check } = await hub
        .from("statement_chunk_jobs")
        .select("status")
        .eq("id", jobId)
        .maybeSingle();

      if (check && check.status === "processing_chunked") {
        console.error(`[chunk-worker] FINAL GUARD: job=${jobId} still processing_chunked, forcing terminal`);
        await hub.from("statement_chunk_jobs").update({
          status: "chunk_processing_failed",
          last_error: "final_guard:still_processing_after_handler",
          reason_codes: [...reasonCodes, "final_guard_triggered"],
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", jobId);
      }
    } catch (guardErr) {
      console.error(`[chunk-worker] final guard check failed: ${guardErr}`);
    }
  }
});

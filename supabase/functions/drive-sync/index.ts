import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_API_KEY = Deno.env.get("Google_Cloud_Key")!;
const DRIVE_FOLDER_ID = Deno.env.get("DRIVE_FOLDER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Supported MIME types
const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document", // Google Docs → export as PDF
]);

async function getOrCreateClient(folderId: string, folderName: string): Promise<string> {
  const { data: existing } = await supabase
    .from("clients")
    .select("id")
    .eq("drive_folder_id", folderId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("clients")
    .insert({ name: folderName, drive_folder_id: folderId })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create client: ${error.message}`);
  return created.id;
}

async function listDriveFiles(folderId: string, pageToken?: string) {
  const q = `'${folderId}' in parents and trashed = false`;
  let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents,sha256Checksum,size)&key=${GOOGLE_API_KEY}&pageSize=100`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function listSubfolders(folderId: string) {
  const q = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&key=${GOOGLE_API_KEY}&pageSize=100`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function computeSha256(content: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("🔄 Starting Drive sync...");

    // Create a sync run
    const { data: run, error: runError } = await supabase
      .from("drive_sync_runs")
      .insert({ status: "running" })
      .select("id")
      .single();

    if (runError) throw new Error(`Failed to create sync run: ${runError.message}`);
    const runId = run.id;

    let totalProcessed = 0;
    let totalErrors = 0;

    // Step 1: List client subfolders under root DRIVE_FOLDER_ID
    const { files: subfolders } = await listSubfolders(DRIVE_FOLDER_ID);
    console.log(`📁 Found ${subfolders?.length || 0} client folders`);

    // Also process files directly in root folder
    const foldersToProcess = [
      { id: DRIVE_FOLDER_ID, name: "Default Client", isRoot: true },
      ...(subfolders || []).map((f: any) => ({ id: f.id, name: f.name, isRoot: false })),
    ];

    for (const folder of foldersToProcess) {
      try {
        const clientId = await getOrCreateClient(folder.id, folder.name);
        let pageToken: string | undefined;

        do {
          const result = await listDriveFiles(folder.id, pageToken);
          const files = result.files || [];
          pageToken = result.nextPageToken;

          for (const file of files) {
            if (!SUPPORTED_MIMES.has(file.mimeType)) {
              console.log(`⏭️ Skipping unsupported: ${file.name} (${file.mimeType})`);
              continue;
            }

            try {
              // Check if document already exists and is up to date
              const { data: existingDoc } = await supabase
                .from("documents")
                .select("id, drive_modified_time, sha256")
                .eq("drive_file_id", file.id)
                .eq("is_deleted", false)
                .maybeSingle();

              if (existingDoc && existingDoc.drive_modified_time === file.modifiedTime) {
                console.log(`✅ Already current: ${file.name}`);
                continue;
              }

              // Determine original and processed MIME types
              const isGoogleDoc = file.mimeType === "application/vnd.google-apps.document";
              const isDocx = file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
              const originalMime = file.mimeType;
              const processedMime = "application/pdf";

              // Compute SHA256 from file ID + modified time as proxy
              const encoder = new TextEncoder();
              const shaInput = encoder.encode(`${file.id}:${file.modifiedTime}`);
              const hashBuffer = await crypto.subtle.digest("SHA-256", shaInput);
              const sha256 = Array.from(new Uint8Array(hashBuffer))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

              // Record sync event
              await supabase.from("drive_sync_events").insert({
                run_id: runId,
                drive_file_id: file.id,
                drive_modified_time: file.modifiedTime,
                event_type: existingDoc ? "update" : "create",
                status: "pending",
                client_id: clientId,
                previous_modified_time: existingDoc?.drive_modified_time || null,
              });

              // Upsert document record
              const docData = {
                client_id: clientId,
                drive_file_id: file.id,
                drive_modified_time: file.modifiedTime,
                drive_parent_folder_id: folder.id,
                file_name: file.name,
                mime_type: file.mimeType,
                original_mime_type: originalMime,
                processed_mime_type: processedMime,
                sha256,
                status: "pending",
                is_deleted: false,
                conversion_status: isGoogleDoc || isDocx ? "pending" : "not_needed",
                doc_type: null,
              };

              let documentId: string;
              if (existingDoc) {
                const { error: updateError } = await supabase
                  .from("documents")
                  .update({ ...docData, updated_at: new Date().toISOString(), source_version: 1 })
                  .eq("id", existingDoc.id);
                if (updateError) throw updateError;
                documentId = existingDoc.id;
              } else {
                const { data: newDoc, error: insertError } = await supabase
                  .from("documents")
                  .insert(docData)
                  .select("id")
                  .single();
                if (insertError) throw insertError;
                documentId = newDoc.id;
              }

              // Create ingestion job
              await supabase.from("ingestion_jobs").insert({
                client_id: clientId,
                document_id: documentId,
                drive_file_id: file.id,
                job_type: "full_ingestion",
                status: "queued",
              });

              totalProcessed++;
              console.log(`📄 Queued: ${file.name} (${existingDoc ? "update" : "new"})`);
            } catch (fileErr) {
              totalErrors++;
              console.error(`❌ Error processing ${file.name}:`, fileErr);
              await supabase.from("drive_sync_events").insert({
                run_id: runId,
                drive_file_id: file.id,
                drive_modified_time: file.modifiedTime,
                event_type: "error",
                status: "failed",
                client_id: clientId,
                last_error: String(fileErr),
              });
            }
          }
        } while (pageToken);
      } catch (folderErr) {
        totalErrors++;
        console.error(`❌ Error processing folder ${folder.name}:`, folderErr);
      }
    }

    // Complete the sync run
    await supabase
      .from("drive_sync_runs")
      .update({
        status: totalErrors > 0 ? "completed_with_errors" : "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    const summary = {
      run_id: runId,
      total_processed: totalProcessed,
      total_errors: totalErrors,
      folders_scanned: foldersToProcess.length,
    };

    console.log("✅ Sync complete:", summary);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("💥 Sync failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

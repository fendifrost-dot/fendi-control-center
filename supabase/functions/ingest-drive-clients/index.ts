import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_API_KEY = Deno.env.get("Google_Cloud_Key")!;
const RAW_DRIVE_FOLDER = Deno.env.get("DRIVE_FOLDER_ID")!;
const DRIVE_FOLDER_ID = RAW_DRIVE_FOLDER.includes("/folders/")
  ? RAW_DRIVE_FOLDER.split("/folders/").pop()!.split("?")[0]
  : RAW_DRIVE_FOLDER;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CG_URL = Deno.env.get("CREDIT_GUARDIAN_URL") || "https://gflvvzkiuleeochqcdeb.supabase.co";
const CG_KEY = Deno.env.get("CREDIT_GUARDIAN_KEY") || "";
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document",
]);

const MAX_RUNTIME_MS = 50000; // Return early at 50s to avoid 60s hard timeout

// --- Drive helpers ---

async function listSubfolders(folderId: string) {
  const q = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&key=${GOOGLE_API_KEY}&pageSize=200`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function listFilesInFolder(folderId: string) {
  const q = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&key=${GOOGLE_API_KEY}&pageSize=200`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function downloadFileContent(
  fileId: string,
  mimeType: string
): Promise<{ text?: string; base64?: string; fileMime: string }> {
  if (mimeType === "application/vnd.google-apps.document") {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&key=${GOOGLE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    return { text: await resp.text(), fileMime: "text/plain" };
  }
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64 = btoa(binary);
  return { base64, fileMime: mimeType };
}

const EXTRACTION_PROMPT = `You are a forensic credit analyst. Analyze this document and extract ALL timeline events related to credit disputes, account changes, bureau responses, or financial events.\n\nReturn a JSON array of events. Each event should have:\n- "date": ISO date string or "unknown"\n- "event_type": one of ["dispute_filed", "bureau_response", "account_opened", "account_closed", "payment_missed", "collection_added", "collection_removed", "inquiry_added", "inquiry_removed", "score_change", "letter_sent", "letter_received", "other"]\n- "description": brief description\n- "bureau": "equifax" | "experian" | "transunion" | null\n- "account_name": creditor/account name if mentioned, null otherwise\n- "confidence": 0.0-1.0\n\nIf no credit-related events are found, return an empty array [].\nReturn ONLY the JSON array, no markdown or explanation.`;

async function extractTimelineEvents(
  fileName: string,
  content: { text?: string; base64?: string; fileMime: string }
): Promise<any[]> {
  const parts: any[] = [];
  if (content.base64) {
    parts.push({ inline_data: { mime_type: content.fileMime, data: content.base64 } });
    parts.push({ text: `Document filename: "${fileName}"\n\n${EXTRACTION_PROMPT}` });
  } else if (content.text) {
    const textSlice = content.text.slice(0, 12000);
    parts.push({ text: `Document: "${fileName}"\nContent (first 12000 chars):\n${textSlice}\n\n${EXTRACTION_PROMPT}` });
  } else {
    return [];
  }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } }),
    }
  );
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    console.error(`Gemini extraction failed for ${fileName}: ${resp.status} ${errBody.slice(0, 200)}`);
    return [];
  }
  const result = await resp.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`Failed to parse Gemini response for ${fileName}:`, e);
  }
  return [];
}

async function pushEventsToCreditGuardian(
  clientName: string,
  events: any[]
): Promise<{ success: boolean; count: number; error?: string }> {
  if (!CG_KEY) return { success: false, count: 0, error: "CREDIT_GUARDIAN_KEY not set" };
  const pushUrl = `${CG_URL}/functions/v1/cross-project-api`;
  console.log(`  Pushing ${events.length} events to CG for "${clientName}" -> ${pushUrl}`);
  try {
    const resp = await fetch(pushUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CG_KEY },
      body: JSON.stringify({ action: "import_timeline_events", client_name: clientName, events }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`  CG API error ${resp.status}: ${errText.slice(0, 300)}`);
      return { success: false, count: 0, error: `CG API ${resp.status}: ${errText.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (data.error) return { success: false, count: 0, error: String(data.error).slice(0, 200) };
    return { success: true, count: data.imported_count || events.length };
  } catch (err) {
    console.error(`  CG push exception for "${clientName}":`, err);
    return { success: false, count: 0, error: String(err).slice(0, 200) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const startTime = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const filterClientName = body.client_name?.toLowerCase()?.trim();
    const maxFiles = body.max_files ?? 5;
    const skipClients = body.skip_clients ?? 0;
    console.log("Starting Drive ingestion...");
    console.log(`Root folder: ${DRIVE_FOLDER_ID}`);
    console.log(`CG target: ${CG_URL}/functions/v1/cross-project-api`);
    console.log(`CG key set: ${CG_KEY ? "yes (" + CG_KEY.slice(0, 6) + "...)" : "NO - events will not push!"}`);
    console.log(`Max files: ${maxFiles}, Skip clients: ${skipClients}`);
    if (filterClientName) console.log(`Filtering to client: ${filterClientName}`);
    const { files: subfolders } = await listSubfolders(DRIVE_FOLDER_ID);
    console.log(`Found ${subfolders?.length || 0} client folders`);
    let totalFilesProcessed = 0;
    let timedOut = false;
    let clientsSkipped = 0;
    const results: Array<{
      client: string; folder_id: string; files_processed: number;
      events_extracted: number; events_pushed: number; errors: string[];
    }> = [];
    for (const folder of subfolders || []) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.log(`Approaching timeout after ${(Date.now() - startTime) / 1000}s - returning partial results`);
        timedOut = true;
        break;
      }
      if (filterClientName && !folder.name.toLowerCase().includes(filterClientName)) continue;
      if (!filterClientName && clientsSkipped < skipClients) {
        clientsSkipped++;
        continue;
      }
      if (totalFilesProcessed >= maxFiles) {
        console.log(`Hit max_files limit (${maxFiles}) - returning partial results`);
        timedOut = true;
        break;
      }
      const clientResult = {
        client: folder.name, folder_id: folder.id, files_processed: 0,
        events_extracted: 0, events_pushed: 0, errors: [] as string[],
      };
      try {
        const { files } = await listFilesInFolder(folder.id);
        const supportedFiles = (files || []).filter((f: any) => SUPPORTED_MIMES.has(f.mimeType));
        console.log(`${folder.name}: ${supportedFiles.length} supported files (of ${(files || []).length} total)`);
        const newFiles: any[] = [];
        for (const file of supportedFiles) {
          const { data: existing } = await supabase
            .from("documents")
            .select("id")
            .eq("drive_file_id", file.id)
            .eq("is_deleted", false)
            .maybeSingle();
          if (existing) {
            console.log(`  Already tracked: ${file.name} - skipping`);
          } else {
            newFiles.push(file);
          }
        }
        if (newFiles.length === 0) {
          console.log(`  All files already tracked for ${folder.name} - skipping`);
          results.push(clientResult);
          continue;
        }
        console.log(`  ${newFiles.length} new files to process for ${folder.name}`);
        let allEvents: any[] = [];
        for (const file of newFiles) {
          if (totalFilesProcessed >= maxFiles) break;
          if (Date.now() - startTime > MAX_RUNTIME_MS) {
            timedOut = true;
            break;
          }
          try {
            console.log(`  Processing: ${file.name} (${file.mimeType})`);
            const content = await downloadFileContent(file.id, file.mimeType);
            if (content.text && content.text.trim().length < 50) {
              console.log(`    Skipping ${file.name}: text too short`);
              continue;
            }
            if (content.base64 && content.base64.length < 1000) {
              console.log(`    Skipping ${file.name}: file too small`);
              continue;
            }
            const events = await extractTimelineEvents(file.name, content);
            console.log(`    Extracted ${events.length} events from ${file.name}`);
            allEvents.push(...events.map((e) => ({ ...e, source_file: file.name, drive_file_id: file.id })));
            clientResult.files_processed++;
            totalFilesProcessed++;
            try {
              const { data: clientRecord } = await supabase
                .from("clients").select("id").eq("drive_folder_id", folder.id).maybeSingle();
              let clientId;
              if (clientRecord) {
                clientId = clientRecord.id;
              } else {
                const { data: newClient, error: clientErr } = await supabase
                  .from("clients").insert({ name: folder.name, drive_folder_id: folder.id }).select("id").single();
                if (clientErr) throw clientErr;
                clientId = newClient.id;
              }
              const sha256Input = new TextEncoder().encode(`${file.id}:${file.modifiedTime}`);
              const hashBuffer = await crypto.subtle.digest("SHA-256", sha256Input);
              const sha256 = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
              await supabase.from("documents").insert({
                client_id: clientId, drive_file_id: file.id, drive_modified_time: file.modifiedTime,
                drive_parent_folder_id: folder.id, file_name: file.name, mime_type: file.mimeType,
                original_mime_type: file.mimeType, processed_mime_type: "application/pdf",
                sha256, status: "ingested", is_deleted: false,
              });
            } catch (docErr) {
              console.error(`    Doc tracking error for ${file.name}:`, docErr);
            }
          } catch (fileErr) {
            const errMsg = `${file.name}: ${String(fileErr).slice(0, 100)}`;
            console.error(`    ${errMsg}`);
            clientResult.errors.push(errMsg);
          }
        }
        clientResult.events_extracted = allEvents.length;
        if (allEvents.length > 0) {
          const pushResult = await pushEventsToCreditGuardian(folder.name, allEvents);
          if (pushResult.success) {
            clientResult.events_pushed = pushResult.count;
            console.log(`  Pushed ${pushResult.count} events to Credit Guardian for ${folder.name}`);
          } else {
            clientResult.errors.push(`CG push failed: ${pushResult.error}`);
            console.error(`  CG push failed for ${folder.name}: ${pushResult.error}`);
          }
        }
      } catch (folderErr) {
        clientResult.errors.push(String(folderErr).slice(0, 200));
        console.error(`Error processing folder ${folder.name}:`, folderErr);
      }
      results.push(clientResult);
    }
    const summary = {
      total_clients: results.length,
      total_files_processed: results.reduce((s, r) => s + r.files_processed, 0),
      total_events_extracted: results.reduce((s, r) => s + r.events_extracted, 0),
      total_events_pushed: results.reduce((s, r) => s + r.events_pushed, 0),
      total_errors: results.reduce((s, r) => s + r.errors.length, 0),
      partial: timedOut,
      elapsed_ms: Date.now() - startTime,
      clients: results,
    };
    console.log("Ingestion complete:", JSON.stringify(summary, null, 2));
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Ingestion failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_API_KEY = Deno.env.get("Google_Cloud_Key")!;
const RAW_DRIVE_FOLDER = Deno.env.get("DRIVE_FOLDER_ID")!;
const DRIVE_FOLDER_ID = RAW_DRIVE_FOLDER.includes("/folders/")
  ? RAW_DRIVE_FOLDER.split("/folders/").pop()!.split("?")[0]
  : RAW_DRIVE_FOLDER;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CG_URL = Deno.env.get("CREDIT_GUARDIAN_URL") || "https://gflvvzkiuleeochqcdeb.supabase.co";
const CG_KEY = Deno.env.get("CREDIT_GUARDIAN_KEY")!;
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Supported file types for ingestion
const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document",
]);

// ─── Drive helpers ─────────────────────────────────────────────

async function listSubfolders(folderId: string) {
  const q = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&key=${GOOGLE_API_KEY}&pageSize=100`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function listFilesInFolder(folderId: string) {
  const q = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&key=${GOOGLE_API_KEY}&pageSize=100`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function downloadFileContent(fileId: string, mimeType: string): Promise<string> {
  let url: string;
  if (mimeType === "application/vnd.google-apps.document") {
    // Export Google Docs as plain text for extraction
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&key=${GOOGLE_API_KEY}`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  return await resp.text();
}

// ─── AI extraction via Gemini ──────────────────────────────────

async function extractTimelineEvents(fileName: string, textContent: string): Promise<any[]> {
  const prompt = `You are a forensic credit analyst. Analyze this document and extract ALL timeline events related to credit disputes, account changes, bureau responses, or financial events.

Document: "${fileName}"
Content (first 8000 chars):
${textContent.slice(0, 8000)}

Return a JSON array of events. Each event should have:
- "date": ISO date string or "unknown"
- "event_type": one of ["dispute_filed", "bureau_response", "account_opened", "account_closed", "payment_missed", "collection_added", "collection_removed", "inquiry_added", "inquiry_removed", "score_change", "letter_sent", "letter_received", "other"]
- "description": brief description
- "bureau": "equifax" | "experian" | "transunion" | null
- "account_name": creditor/account name if mentioned, null otherwise
- "confidence": 0.0-1.0

Return ONLY the JSON array, no markdown or explanation.`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      }),
    }
  );

  if (!resp.ok) {
    console.error(`Gemini extraction failed: ${resp.status}`);
    return [];
  }

  const result = await resp.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try {
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error(`Failed to parse Gemini response for ${fileName}:`, e);
  }
  return [];
}

// ─── Credit Guardian integration ───────────────────────────────

async function pushEventsToCreditGuardian(clientName: string, events: any[]): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    const resp = await fetch(`${CG_URL}/functions/v1/cross-project-api`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CG_KEY}`,
        "Content-Type": "application/json",
        "x-api-key": CG_KEY,
      },
      body: JSON.stringify({
        action: "import_timeline_events",
        client_name: clientName,
        events,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, count: 0, error: `CG API ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();
    return { success: true, count: data.imported_count || events.length };
  } catch (err) {
    return { success: false, count: 0, error: String(err).slice(0, 200) };
  }
}

// ─── Main handler ──────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const filterClientName = body.client_name?.toLowerCase()?.trim();

    console.log("🔄 Starting Drive ingestion...");
    console.log(`📂 Root folder: ${DRIVE_FOLDER_ID}`);
    if (filterClientName) console.log(`🔍 Filtering to client: ${filterClientName}`);

    // List client subfolders
    const { files: subfolders } = await listSubfolders(DRIVE_FOLDER_ID);
    console.log(`📁 Found ${subfolders?.length || 0} client folders`);

    const results: Array<{
      client: string;
      folder_id: string;
      files_processed: number;
      events_extracted: number;
      events_pushed: number;
      errors: string[];
    }> = [];

    for (const folder of (subfolders || [])) {
      // Apply client name filter if specified
      if (filterClientName && !folder.name.toLowerCase().includes(filterClientName)) {
        continue;
      }

      const clientResult = {
        client: folder.name,
        folder_id: folder.id,
        files_processed: 0,
        events_extracted: 0,
        events_pushed: 0,
        errors: [] as string[],
      };

      try {
        const { files } = await listFilesInFolder(folder.id);
        const supportedFiles = (files || []).filter((f: any) => SUPPORTED_MIMES.has(f.mimeType));

        console.log(`📂 ${folder.name}: ${supportedFiles.length} supported files`);

        let allEvents: any[] = [];

        for (const file of supportedFiles) {
          try {
            console.log(`  📄 Processing: ${file.name}`);

            // Download file content
            const textContent = await downloadFileContent(file.id, file.mimeType);
            if (!textContent || textContent.trim().length < 50) {
              console.log(`  ⏭️ Skipping ${file.name}: too short or empty`);
              continue;
            }

            // Extract timeline events via AI
            const events = await extractTimelineEvents(file.name, textContent);
            console.log(`  ✅ Extracted ${events.length} events from ${file.name}`);

            allEvents.push(...events.map(e => ({ ...e, source_file: file.name, drive_file_id: file.id })));
            clientResult.files_processed++;
          } catch (fileErr) {
            const errMsg = `${file.name}: ${String(fileErr).slice(0, 100)}`;
            console.error(`  ❌ ${errMsg}`);
            clientResult.errors.push(errMsg);
          }
        }

        clientResult.events_extracted = allEvents.length;

        // Push all events for this client to Credit Guardian
        if (allEvents.length > 0) {
          const pushResult = await pushEventsToCreditGuardian(folder.name, allEvents);
          if (pushResult.success) {
            clientResult.events_pushed = pushResult.count;
            console.log(`  ✅ Pushed ${pushResult.count} events to Credit Guardian for ${folder.name}`);
          } else {
            clientResult.errors.push(`CG push failed: ${pushResult.error}`);
            console.error(`  ❌ CG push failed for ${folder.name}: ${pushResult.error}`);
          }
        }

        // Also record in local documents table for tracking
        for (const file of supportedFiles) {
          try {
            const { data: existing } = await supabase
              .from("documents")
              .select("id")
              .eq("drive_file_id", file.id)
              .eq("is_deleted", false)
              .maybeSingle();

            if (existing) continue; // Already tracked

            // Get or create client record
            const { data: clientRecord } = await supabase
              .from("clients")
              .select("id")
              .eq("drive_folder_id", folder.id)
              .maybeSingle();

            let clientId: string;
            if (clientRecord) {
              clientId = clientRecord.id;
            } else {
              const { data: newClient, error: clientErr } = await supabase
                .from("clients")
                .insert({ name: folder.name, drive_folder_id: folder.id })
                .select("id")
                .single();
              if (clientErr) throw clientErr;
              clientId = newClient.id;
            }

            const sha256Input = new TextEncoder().encode(`${file.id}:${file.modifiedTime}`);
            const hashBuffer = await crypto.subtle.digest("SHA-256", sha256Input);
            const sha256 = Array.from(new Uint8Array(hashBuffer))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");

            await supabase.from("documents").insert({
              client_id: clientId,
              drive_file_id: file.id,
              drive_modified_time: file.modifiedTime,
              drive_parent_folder_id: folder.id,
              file_name: file.name,
              mime_type: file.mimeType,
              original_mime_type: file.mimeType,
              processed_mime_type: "application/pdf",
              sha256,
              status: "ingested",
              is_deleted: false,
            });
          } catch (docErr) {
            // Non-fatal: document tracking is secondary
            console.error(`  ⚠️ Doc tracking error for ${file.name}:`, docErr);
          }
        }
      } catch (folderErr) {
        clientResult.errors.push(String(folderErr).slice(0, 200));
        console.error(`❌ Error processing folder ${folder.name}:`, folderErr);
      }

      results.push(clientResult);
    }

    const summary = {
      total_clients: results.length,
      total_files_processed: results.reduce((s, r) => s + r.files_processed, 0),
      total_events_extracted: results.reduce((s, r) => s + r.events_extracted, 0),
      total_events_pushed: results.reduce((s, r) => s + r.events_pushed, 0),
      total_errors: results.reduce((s, r) => s + r.errors.length, 0),
      clients: results,
    };

    console.log("✅ Ingestion complete:", JSON.stringify(summary, null, 2));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("💥 Ingestion failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

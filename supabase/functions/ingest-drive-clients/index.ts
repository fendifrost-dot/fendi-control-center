import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import { isAmbiguousCreditTaxFolderName, shouldIngestCreditSubfolder } from "../_shared/driveFolderPolicy.ts";

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

/** When true, every direct subfolder of DRIVE_FOLDER_ID is treated as a credit client (no "CREDIT" in name required). */
const DEDICATED_CREDIT_ROOT =
  Deno.env.get("DRIVE_CREDIT_ROOT_IS_DEDICATED") === "1" ||
  Deno.env.get("DRIVE_CREDIT_ROOT_IS_DEDICATED") === "true";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;


const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document",
]);

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

// Download file as text (for Google Docs) or raw bytes (for PDF/DOCX)
async function downloadFile(fileId: string, mimeType: string): Promise<{ text: string; base64: string | null; rawMime: string }> {
  let url: string;
  if (mimeType === "application/vnd.google-apps.document") {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&key=${GOOGLE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const text = await resp.text();
    return { text, base64: null, rawMime: "text/plain" };
  } else {
    // For PDFs and DOCX, download as binary and convert to base64
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);

    // Convert to base64
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binary);

    // Also try to extract text (works for some DOCX, not for PDF)
    let text = "";
    try {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      text = decoder.decode(bytes);
      // If the text is mostly non-printable chars, it's binary garbage
      const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, "");
      if (printable.length < text.length * 0.3) {
        text = ""; // Binary file, no usable text
      }
    } catch {
      text = "";
    }

    return { text, base64, rawMime: mimeType };
  }
}

const EXTRACTION_PROMPT = `You are a forensic credit analyst. Analyze this document and extract ALL timeline events related to credit disputes, account changes, bureau responses, or financial events.

Return a JSON array of events. Each event MUST have:
- "date": YYYY-MM-DD format date string. If the exact date is unknown, use the first day of the month (e.g., "2024-03-01"). If no date can be determined at all, use "unknown". NEVER return dates before year 2000. If you see a date that seems like 1969 or 1970, it is an error â use "unknown" instead.
- "event_type": one of ["dispute_filed", "bureau_response", "account_opened", "account_closed", "payment_missed", "collection_added", "collection_removed", "inquiry_added", "inquiry_removed", "score_change", "letter_sent", "letter_received", "other"]
- "description": detailed description of the event including any account numbers, amounts, or reference numbers mentioned
- "bureau": "equifax" | "experian" | "transunion" | null
- "account_name": creditor/account name if mentioned, null otherwise
- "confidence": 0.0-1.0

IMPORTANT: Extract EVERY piece of information. Include account names, dates, dispute reasons, response details, amounts, and any other relevant data. Be thorough â this data is used for legal credit repair tracking.

Return ONLY the JSON array, no markdown or explanation.`;

// Use Gemini multimodal API â can read PDFs and images natively
async function extractWithGeminiMultimodal(fileName: string, base64Data: string, mimeType: string): Promise<any[]> {
  console.log(`  Gemini multimodal extraction for ${fileName} (${mimeType})`);
  const parts: any[] = [
    { inline_data: { mime_type: mimeType, data: base64Data } },
    { text: `${EXTRACTION_PROMPT}\n\nDocument filename: "${fileName}"` },
  ];
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Gemini multimodal failed: ${resp.status} ${errText.slice(0, 200)}`);
    return [];
  }
  const result = await resp.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) { return JSON.parse(jsonMatch[0]); }
  } catch (e) {
    console.error(`Failed to parse Gemini multimodal response for ${fileName}:`, e);
  }
  return [];
}

// Gemini text-only extraction (for Google Docs text)
async function extractWithGeminiText(fileName: string, textContent: string): Promise<any[]> {
  console.log(`  Gemini text extraction for ${fileName}`);
  const prompt = `${EXTRACTION_PROMPT}\n\nDocument: "${fileName}"\nContent (first 12000 chars):\n${textContent.slice(0, 12000)}`;
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Gemini text extraction failed: ${resp.status} ${errText.slice(0, 200)}`);
    return [];
  }
  const result = await resp.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) { return JSON.parse(jsonMatch[0]); }
  } catch (e) {
    console.error(`Failed to parse Gemini text response for ${fileName}:`, e);
  }
  return [];
}

// Grok text-only fallback
async function extractWithGrok(fileName: string, textContent: string): Promise<any[]> {
  console.log(`  Grok fallback extraction for ${fileName}`);
  const userMessage = `Document: "${fileName}"\nContent (first 8000 chars):\n${textContent.slice(0, 8000)}`;
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("Frost_Grok") || ""}`,
    },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Grok extraction failed: ${resp.status} ${errText.slice(0, 200)}`);
    return [];
  }
  const result = await resp.json();
  const text = result?.choices?.[0]?.message?.content || "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) { return JSON.parse(jsonMatch[0]); }
  } catch (e) {
    console.error(`Failed to parse Grok response for ${fileName}:`, e);
  }
  return [];
}

// Validate and fix dates â reject 1969/1970 epoch dates
function validateEvents(events: any[]): any[] {
  return events.map(e => {
    let date = e.date;
    if (date && date !== "unknown") {
      // Check for epoch dates (1969, 1970) or dates before 2000
      const year = parseInt(date.substring(0, 4), 10);
      if (isNaN(year) || year < 2000 || year > 2030) {
        console.log(`  Fixed invalid date ${date} â "unknown"`);
        date = "unknown";
      }
    }
    return { ...e, date };
  }).filter(e => {
    // Filter out events with no useful info
    if (!e.description || e.description.trim().length < 5) return false;
    return true;
  });
}

// Main extraction logic: Gemini primary (multimodal for PDFs), Grok fallback for text
async function extractTimelineEvents(
  fileName: string,
  fileData: { text: string; base64: string | null; rawMime: string }
): Promise<any[]> {
  let events: any[] = [];

  // Strategy 1: If we have base64 data (PDF/DOCX), use Gemini multimodal
  if (fileData.base64 && (fileData.rawMime === "application/pdf" || fileData.rawMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
    events = await extractWithGeminiMultimodal(fileName, fileData.base64, fileData.rawMime);
    if (events.length > 0) {
      console.log(`  Gemini multimodal extracted ${events.length} events`);
      return validateEvents(events);
    }
    console.log(`  Gemini multimodal returned 0 events`);
  }

  // Strategy 2: If we have usable text, try Gemini text extraction
  if (fileData.text && fileData.text.trim().length >= 50) {
    events = await extractWithGeminiText(fileName, fileData.text);
    if (events.length > 0) {
      console.log(`  Gemini text extracted ${events.length} events`);
      return validateEvents(events);
    }

    // Strategy 3: Grok fallback for text
    events = await extractWithGrok(fileName, fileData.text);
    if (events.length > 0) {
      console.log(`  Grok extracted ${events.length} events`);
      return validateEvents(events);
    }
  }

  console.log(`  All extractors returned 0 events for ${fileName}`);
  return [];
}

async function pushEventsToCreditGuardian(clientName: string, events: any[]): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    const resp = await fetchCreditGuardian({
      action: "import_timeline_events",
      client_name: clientName,
      events,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, count: 0, error: `CG API ${resp.status}: ${errText.slice(0, 200)}` };
    }
    const data = await resp.json();
    if (data.error) {
      return { success: false, count: 0, error: String(data.error).slice(0, 200) };
    }


    return { success: true, count: data.imported_count ?? events.length };
  } catch (err) {
    return { success: false, count: 0, error: String(err).slice(0, 200) };
  }
}

// Track a single file in the documents table (per-file dedup)
async function trackDocument(file: any, folder: any): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("documents")
      .select("id")
      .eq("drive_file_id", file.id)
      .eq("is_deleted", false)
      .maybeSingle();

    if (existing) return; // Already tracked

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
        .insert({ name: folder.name, drive_folder_id: folder.id, client_pipeline: "credit" })
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

    const { error: insertErr } = await supabase.from("documents").insert({
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
    if (insertErr) {
      console.error(`  Doc insert FAILED for ${file.name}: ${JSON.stringify(insertErr)}`);
      throw insertErr;
    }
    console.log(`  Doc tracked successfully: ${file.name}`);
  } catch (docErr) {
    console.error(`  Doc tracking error for ${file.name}:`, docErr);
  }
}

// Check if a file has already been processed (dedup check)
async function isFileAlreadyProcessed(fileId: string): Promise<boolean> {
  const { data } = await supabase
    .from("documents")
    .select("id")
    .eq("drive_file_id", fileId)
    .eq("is_deleted", false)
    .maybeSingle();
  return !!data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const filterClientName = body.client_name?.toLowerCase()?.trim();
    const maxFiles = parseInt(body.max_files) || 0; // 0 = no limit

    console.log("Starting Drive ingestion (Gemini multimodal v3 - per-file dedup)...");
    console.log(`Root folder: ${DRIVE_FOLDER_ID}`);
    console.log(`DRIVE_CREDIT_ROOT_IS_DEDICATED: ${DEDICATED_CREDIT_ROOT}`);
    if (filterClientName) console.log(`Filtering to client: ${filterClientName}`);
    if (maxFiles > 0) console.log(`Max files per client: ${maxFiles}`);

    const { files: subfolders } = await listSubfolders(DRIVE_FOLDER_ID);
    console.log(`Found ${subfolders?.length || 0} client folders`);

    const results: Array<{
      client: string;
      folder_id: string;
      files_processed: number;
      events_extracted: number;
      events_pushed: number;
      errors: string[];
    }> = [];

    for (const folder of (subfolders || [])) {
      if (isAmbiguousCreditTaxFolderName(folder.name)) {
        console.log(`Skipping ambiguous folder (rename to separate credit vs tax): ${folder.name}`);
        continue;
      }
      if (!shouldIngestCreditSubfolder(folder.name, { dedicatedCreditRoot: DEDICATED_CREDIT_ROOT })) {
        console.log(
          `Skipping folder (not a credit client folder under current rules): ${folder.name} ` +
            `(dedicatedCreditRoot=${DEDICATED_CREDIT_ROOT} — set DRIVE_CREDIT_ROOT_IS_DEDICATED=true if this root is credit-only)`,
        );
        continue;
      }
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
        console.log(`${folder.name}: ${supportedFiles.length} supported files`);

        let allEvents: any[] = [];
        let filesProcessedCount = 0;

        for (const file of supportedFiles) {
          // Per-file deduplication check BEFORE processing
          const alreadyDone = await isFileAlreadyProcessed(file.id);
          if (alreadyDone) {
            console.log(`  Skipping ${file.name}: already processed (dedup)`);
            continue;
          }

          // max_files limit check
          if (maxFiles > 0 && filesProcessedCount >= maxFiles) {
            console.log(`  Reached max_files limit (${maxFiles}), stopping`);
            break;
          }

          try {
            console.log(`  Processing: ${file.name} (${file.mimeType})`);
            const fileData = await downloadFile(file.id, file.mimeType);

            // Skip if no data at all
            if (!fileData.text && !fileData.base64) {
              console.log(`  Skipping ${file.name}: no data`);
              // Track it anyway so we don't retry
              await trackDocument(file, folder);
              continue;
            }

            // For text-only files, check minimum length
            if (!fileData.base64 && fileData.text.trim().length < 50) {
              console.log(`  Skipping ${file.name}: text too short`);
              await trackDocument(file, folder);
              continue;
            }

            const events = await extractTimelineEvents(file.name, fileData);
            console.log(`  Extracted ${events.length} validated events from ${file.name}`);

            allEvents.push(...events.map(e => ({
              ...e,
              source_file: file.name,
              drive_file_id: file.id
            })));
            clientResult.files_processed++;
            filesProcessedCount++;

            // Track document IMMEDIATELY after processing (per-file dedup)
            await trackDocument(file, folder);

          } catch (fileErr) {
            const errMsg = `${file.name}: ${String(fileErr).slice(0, 100)}`;
            console.error(`  Error: ${errMsg}`);
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

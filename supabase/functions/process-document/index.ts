import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;
const GOOGLE_API_KEY = Deno.env.get("Google_Cloud_Key")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROK_KEY = Deno.env.get("Frost_Grok")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";
const MAX_RETRIES = 3;
const TIMEOUT_SECONDS = 50;

// ─── Get active AI model ────────────────────────────────────────
async function getActiveModel(): Promise<string> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "ai_model")
    .single();
  return data?.setting_value || "gemini";
}

// ─── AI Error Translation ───────────────────────────────────────
async function translateError(rawError: string, fileName: string): Promise<string> {
  const model = await getActiveModel();
  const prompt = `You are the Fendi Control Center AI. A document processing task failed. Translate this technical error into a simple, plain English explanation for the boss. No jargon. Be helpful and suggest what to do next.

File: ${fileName}
Raw Error: ${rawError}

Reply with ONLY the plain English explanation (2-3 sentences max).`;

  try {
    if (model === "grok") {
      const resp = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "grok-3-mini-fast",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 256,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || "An unknown processing error occurred.";
      }
    }
    // Fallback to Gemini
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256 },
        }),
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "An unknown processing error occurred.";
    }
  } catch (e) {
    console.error("Error translation failed:", e);
  }
  return "A processing error occurred that we couldn't automatically diagnose. Please check the raw logs.";
}

// ─── Send SOS to Telegram ───────────────────────────────────────
async function sendSOSNotification(jobId: string, fileName: string, clientName: string, rawError: string, explanation: string) {
  try {
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
    await fetch(`${SUPABASE_URL}/functions/v1/notify-telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        sos: true,
        job_id: jobId,
        file_name: fileName,
        client_name: clientName,
        raw_error: rawError,
        explanation,
      }),
    });
  } catch (e) {
    console.error("Failed to send SOS notification:", e);
  }
}

// ─── Trigger continuation (Immortal Tasks) ──────────────────────
async function triggerContinuation(jobId: string) {
  try {
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
    await fetch(`${SUPABASE_URL}/functions/v1/process-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ job_id: jobId, continuation: true }),
    });
  } catch (e) {
    console.error("Continuation trigger failed:", e);
  }
}

// ─── Update job heartbeat ───────────────────────────────────────
async function heartbeat(jobId: string) {
  await supabase
    .from("ingestion_jobs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", jobId);
}

// ─── Exponential backoff delay ──────────────────────────────────
function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
}

// ─── Download file content from Drive ────────────────────────────
async function downloadDriveFile(fileId: string, mimeType: string): Promise<{ content: string; downloadMime: string }> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  
  let url: string;
  let downloadMime: string;
  
  if (isGoogleDoc) {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf&key=${GOOGLE_API_KEY}`;
    downloadMime = "application/pdf";
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
    downloadMime = mimeType;
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive download error: ${resp.status} ${await resp.text()}`);
  
  const buffer = await resp.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return { content: base64, downloadMime };
}

// ─── Credit Report Extraction Prompt ─────────────────────────────
const CREDIT_REPORT_PROMPT = `You are a credit report analysis expert. Analyze this document and extract ALL data into structured JSON.

Return a JSON object with these top-level keys:
{
  "doc_type": "credit_report",
  "bureau": "equifax" | "experian" | "transunion" | null,
  "report_date": "YYYY-MM-DD" or null,
  "personal_info": [
    { "field_name": "full_name" | "ssn_last4" | "dob" | "address" | "employer" | "phone", "value": "...", "evidence": "...", "page": N }
  ],
  "tradelines": [
    {
      "object_key": "creditor_name::account_number_last4",
      "fields": {
        "creditor_name": "...",
        "account_number": "...",
        "account_type": "...",
        "status": "...",
        "date_opened": "...",
        "balance": "...",
        "credit_limit": "...",
        "payment_status": "...",
        "monthly_payment": "...",
        "high_balance": "...",
        "last_reported": "...",
        "remarks": "..."
      },
      "evidence": "...",
      "page_range": "1-2"
    }
  ],
  "inquiries": [
    {
      "object_key": "creditor_name::date",
      "fields": {
        "creditor_name": "...",
        "inquiry_date": "...",
        "inquiry_type": "hard" | "soft"
      },
      "evidence": "...",
      "page": N
    }
  ],
  "public_records": [...],
  "collections": [...]
}

Extract EVERY tradeline, inquiry, and personal detail. Be thorough. Include evidence snippets.

ACCOUNT NUMBER RULE:

Preserve account_number exactly as printed in the report including *, X, XXXX, partial prefixes, spacing, and "Not Displayed". Never truncate. Never normalize. If no account number exists omit the field entirely.

BUREAU DETECTION RULES:

- Experian: treat each "Account Number" or "Account Name" occurrence as a new tradeline block. Handle non-ASCII glyphs near headings. Treat "POTENTIALLY NEGATIVE" banners as tradeline anchors.

- Credit Karma / TransUnion: treat each creditor card as one tradeline. Account number may show as "Not Displayed" — output exactly that string.

- Equifax / Annual Credit Report: use "Account Information" headers as block anchors.

NEGATIVE INDICATOR SCAN ZONES (scan ONLY these — never scan legend or glossary sections):

1. status / payment_status / current_status fields

2. remarks / comments fields

3. past due amount fields

4. times 30/60/90+ late summaries

5. actual month-by-month payment history marks

NEGATIVE INDICATORS (match in scan zones only):

late, late payment, 30 days late, 60 days late, 90 days late, 120 days late, 150 days late, 180 days late, past due, derogatory, charge off, charged off, C/O, written off, collection, placed for collection, payment after charge-off, worst payment status, needs attention, potentially negative

PAYMENT GRID EXTRACTION:

For each page containing a payment history grid, append this structure after the JSON:

TRADELINE PAYMENT RESULT

Account Name: [exact name]

Account Number: [exactly as shown or UNKNOWN]

Payment Flag: NEGATIVE or CLEAN or UNREADABLE

Negative Cells: [YEAR-MONTH-VALUE comma separated or NONE]

Late Count: [number]

Worst Status: [30|60|90|120|150|180|CO|C|NONE]

Cell values: 30=30 days late, 60=60 days late, 90=90 days late, 120=120 days late, 150=150 days late, 180=180 days late, CO=Charge Off, C=Collection, CLS=Closed (not negative), ND=No Data (not negative), blank or green=Current (not negative)

If no payment grid on page return: GRID: NONE`;

// ─── Business/Marketing Document Prompt ──────────────────────────
const BUSINESS_DOC_PROMPT = `Analyze this business document and categorize it. Return JSON:
{
  "doc_type": "invoice" | "ad_report" | "financial_statement" | "contract" | "marketing_report" | "other",
  "category": "marketing" | "finance" | "legal" | "operations",
  "title": "...",
  "date": "YYYY-MM-DD" or null,
  "key_metrics": [
    { "metric_name": "...", "value": "...", "context": "..." }
  ],
  "summary": "Brief 2-3 sentence summary",
  "entities": ["company names, people, etc"],
  "amounts": [{ "description": "...", "amount": N, "currency": "USD" }]
}`;

// ─── Call Gemini ─────────────────────────────────────────────────
async function callGemini(base64Content: string, mimeType: string, prompt: string): Promise<any> {
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Content } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
    },
  };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No content in Gemini response");

  return JSON.parse(text);
}

// ─── Detect if credit report ────────────────────────────────────
function isCreditReport(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.includes("credit") ||
    lower.includes("equifax") ||
    lower.includes("experian") ||
    lower.includes("transunion") ||
    lower.includes("report") ||
    lower.includes("bureau")
  );
}

// ─── Store credit report observations ───────────────────────────
async function storeCreditObservations(clientId: string, documentId: string, data: any) {
  const observations: any[] = [];
  const modelId = "gemini-1.5-pro";

  for (const pi of data.personal_info || []) {
    observations.push({
      client_id: clientId, document_id: documentId,
      object_type: "personal_info", object_key: `personal::${pi.field_name}`,
      field_name: pi.field_name, field_value_text: String(pi.value),
      confidence: 0.9, evidence_snippet: pi.evidence || null,
      page_number: pi.page || null, model_id: modelId,
    });
  }

  for (const tl of data.tradelines || []) {
    for (const [fieldName, fieldValue] of Object.entries(tl.fields || {})) {
      observations.push({
        client_id: clientId, document_id: documentId,
        object_type: "tradeline", object_key: tl.object_key,
        field_name: fieldName, field_value_text: String(fieldValue),
        confidence: 0.85, evidence_snippet: tl.evidence || null,
        evidence_page_range: tl.page_range || null, model_id: modelId,
      });
    }
  }

  for (const inq of data.inquiries || []) {
    for (const [fieldName, fieldValue] of Object.entries(inq.fields || {})) {
      observations.push({
        client_id: clientId, document_id: documentId,
        object_type: "inquiry", object_key: inq.object_key,
        field_name: fieldName, field_value_text: String(fieldValue),
        confidence: 0.9, evidence_snippet: inq.evidence || null,
        page_number: inq.page || null, model_id: modelId,
      });
    }
  }

  if (observations.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < observations.length; i += batchSize) {
      const batch = observations.slice(i, i + batchSize);
      const { error } = await supabase.from("observations").insert(batch);
      if (error) console.error(`Observation batch insert error:`, error);
    }
  }

  return observations.length;
}

// ─── Store business doc observations ────────────────────────────
async function storeBusinessObservations(clientId: string, documentId: string, data: any) {
  const observations: any[] = [];
  const modelId = "gemini-1.5-pro";

  for (const metric of data.key_metrics || []) {
    observations.push({
      client_id: clientId, document_id: documentId,
      object_type: data.doc_type || "business_doc",
      object_key: `${data.doc_type}::${metric.metric_name}`,
      field_name: metric.metric_name, field_value_text: String(metric.value),
      field_value_json: metric, confidence: 0.8,
      evidence_snippet: metric.context || null, model_id: modelId,
    });
  }

  for (const amt of data.amounts || []) {
    observations.push({
      client_id: clientId, document_id: documentId,
      object_type: data.doc_type || "business_doc",
      object_key: `${data.doc_type}::amount::${amt.description}`,
      field_name: "amount", field_value_text: String(amt.amount),
      field_value_json: amt, confidence: 0.85,
      evidence_snippet: amt.description || null, model_id: modelId,
    });
  }

  if (observations.length > 0) {
    const { error } = await supabase.from("observations").insert(observations);
    if (error) console.error("Business observation insert error:", error);
  }

  return observations.length;
}

// ─── Notify Telegram (success) ──────────────────────────────────
async function notifyTelegram(documentName: string, docType: string, observationCount: number, clientName: string, documentId: string, clientId: string) {
  try {
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
    await fetch(`${SUPABASE_URL}/functions/v1/notify-telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        document_name: documentName, doc_type: docType,
        observation_count: observationCount, client_name: clientName,
        document_id: documentId, client_id: clientId,
      }),
    });
  } catch (e) {
    console.error("Failed to send Telegram notification:", e);
  }
}

// ─── Core processing with retry + timeout ───────────────────────
async function processWithRetry(job: any, doc: any, client: any): Promise<any> {
  const startTime = Date.now();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check timeout — if we're past 50s, save state and chain
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > TIMEOUT_SECONDS) {
      console.log(`⏱️ Timeout approaching at ${elapsed.toFixed(1)}s. Chaining continuation for job ${job.id}`);
      await supabase
        .from("ingestion_jobs")
        .update({
          status: "queued",
          last_error: `Timeout at attempt ${attempt + 1}. Auto-chaining.`,
          attempt_count: job.attempt_count + attempt,
          heartbeat_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      // Fire a new invocation to continue
      await triggerContinuation(job.id);
      return { status: "chained", attempt, elapsed: elapsed.toFixed(1) };
    }

    try {
      // Update status to processing/retrying
      const status = attempt === 0 ? "processing" : "retrying";
      await supabase
        .from("ingestion_jobs")
        .update({ status, attempt_count: job.attempt_count + attempt + 1, heartbeat_at: new Date().toISOString() })
        .eq("id", job.id);

      await heartbeat(job.id);

      // Download file
      const { content: base64, downloadMime } = await downloadDriveFile(doc.drive_file_id, doc.mime_type);
      console.log(`📥 Downloaded ${doc.file_name} (${downloadMime}) [attempt ${attempt + 1}]`);

      await heartbeat(job.id);

      if (doc.conversion_status === "pending") {
        await supabase.from("documents").update({ conversion_status: "completed" }).eq("id", doc.id);
      }

      // Analyze
      const creditReport = isCreditReport(doc.file_name);
      const prompt = creditReport ? CREDIT_REPORT_PROMPT : BUSINESS_DOC_PROMPT;

      console.log(`🧠 Analyzing with Gemini (${creditReport ? "credit report" : "business doc"}) [attempt ${attempt + 1}]...`);
      const analysis = await callGemini(base64, downloadMime, prompt);

      await heartbeat(job.id);

      // Store results
      let observationCount: number;
      const detectedDocType = analysis.doc_type || (creditReport ? "credit_report" : "unknown");

      if (creditReport) {
        observationCount = await storeCreditObservations(doc.client_id, doc.id, analysis);
        await supabase.from("documents").update({
          doc_type: "credit_report", bureau: analysis.bureau || null,
          report_date: analysis.report_date || null, status: "completed",
        }).eq("id", doc.id);
      } else {
        observationCount = await storeBusinessObservations(doc.client_id, doc.id, analysis);
        await supabase.from("documents").update({
          doc_type: detectedDocType, status: "completed",
        }).eq("id", doc.id);
      }

      // Success!
      await supabase
        .from("ingestion_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", job.id);

      await notifyTelegram(doc.file_name, detectedDocType, observationCount, client?.name || "Unknown", doc.id, doc.client_id);

      return {
        job_id: job.id, document_id: doc.id, doc_type: detectedDocType,
        observations_created: observationCount, status: "completed", attempts: attempt + 1,
      };

    } catch (err) {
      const errorStr = String(err);
      console.error(`❌ Attempt ${attempt + 1}/${MAX_RETRIES} failed:`, errorStr);

      if (attempt < MAX_RETRIES - 1) {
        // Retry with backoff
        const delay = backoffMs(attempt);
        console.log(`⏳ Retrying in ${(delay / 1000).toFixed(1)}s...`);
        await supabase
          .from("ingestion_jobs")
          .update({
            status: "retrying",
            last_error: errorStr,
            attempt_count: job.attempt_count + attempt + 1,
          })
          .eq("id", job.id);

        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Final failure — translate error and send SOS
        console.error(`💀 All ${MAX_RETRIES} retries exhausted for job ${job.id}`);

        await supabase
          .from("ingestion_jobs")
          .update({
            status: "failed",
            last_error: errorStr,
            attempt_count: job.attempt_count + MAX_RETRIES,
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        await supabase.from("documents").update({ status: "failed" }).eq("id", doc.id);

        // AI Error Translation
        const explanation = await translateError(errorStr, doc.file_name);

        // Telegram SOS
        await sendSOSNotification(job.id, doc.file_name, client?.name || "Unknown", errorStr, explanation);

        throw new Error(`Processing failed after ${MAX_RETRIES} retries: ${errorStr}`);
      }
    }
  }
}

// ─── Main Handler ───────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { job_id, continuation } = await req.json().catch(() => ({ job_id: null, continuation: false }));

    if (continuation) {
      console.log(`🔄 Continuation triggered for job ${job_id}`);
    }

    // Pick job
    let jobQuery;
    if (job_id) {
      jobQuery = supabase
        .from("ingestion_jobs")
        .select("*, documents(*), clients(*)")
        .eq("id", job_id)
        .limit(1);
    } else {
      jobQuery = supabase
        .from("ingestion_jobs")
        .select("*, documents(*), clients(*)")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1);
    }

    const { data: jobs, error: jobError } = await jobQuery;
    if (jobError) throw new Error(`Job query error: ${jobError.message}`);
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ message: "No queued jobs" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const job = jobs[0];
    const doc = job.documents;
    const client = job.clients;

    console.log(`🔬 Processing: ${doc.file_name} (job: ${job.id}, attempt: ${job.attempt_count + 1})`);

    // Mark as processing
    await supabase.from("documents").update({ status: "processing" }).eq("id", doc.id);

    const result = await processWithRetry(job, doc, client);

    console.log("✅ Processing result:", result);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("💥 Process document failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

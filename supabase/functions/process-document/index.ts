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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

// ─── Download file content from Drive ────────────────────────────
async function downloadDriveFile(fileId: string, mimeType: string): Promise<{ content: string; downloadMime: string }> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  
  let url: string;
  let downloadMime: string;
  
  if (isGoogleDoc) {
    // Export Google Docs as PDF
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

Extract EVERY tradeline, inquiry, and personal detail. Be thorough. Include evidence snippets.`;

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
async function storeCreditObservations(
  clientId: string,
  documentId: string,
  data: any
) {
  const observations: any[] = [];
  const modelId = "gemini-1.5-pro";

  // Personal info
  for (const pi of data.personal_info || []) {
    observations.push({
      client_id: clientId,
      document_id: documentId,
      object_type: "personal_info",
      object_key: `personal::${pi.field_name}`,
      field_name: pi.field_name,
      field_value_text: String(pi.value),
      confidence: 0.9,
      evidence_snippet: pi.evidence || null,
      page_number: pi.page || null,
      model_id: modelId,
    });
  }

  // Tradelines
  for (const tl of data.tradelines || []) {
    for (const [fieldName, fieldValue] of Object.entries(tl.fields || {})) {
      observations.push({
        client_id: clientId,
        document_id: documentId,
        object_type: "tradeline",
        object_key: tl.object_key,
        field_name: fieldName,
        field_value_text: String(fieldValue),
        confidence: 0.85,
        evidence_snippet: tl.evidence || null,
        evidence_page_range: tl.page_range || null,
        model_id: modelId,
      });
    }
  }

  // Inquiries
  for (const inq of data.inquiries || []) {
    for (const [fieldName, fieldValue] of Object.entries(inq.fields || {})) {
      observations.push({
        client_id: clientId,
        document_id: documentId,
        object_type: "inquiry",
        object_key: inq.object_key,
        field_name: fieldName,
        field_value_text: String(fieldValue),
        confidence: 0.9,
        evidence_snippet: inq.evidence || null,
        page_number: inq.page || null,
        model_id: modelId,
      });
    }
  }

  // Batch insert observations
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
async function storeBusinessObservations(
  clientId: string,
  documentId: string,
  data: any
) {
  const observations: any[] = [];
  const modelId = "gemini-1.5-pro";

  // Store key metrics as observations
  for (const metric of data.key_metrics || []) {
    observations.push({
      client_id: clientId,
      document_id: documentId,
      object_type: data.doc_type || "business_doc",
      object_key: `${data.doc_type}::${metric.metric_name}`,
      field_name: metric.metric_name,
      field_value_text: String(metric.value),
      field_value_json: metric,
      confidence: 0.8,
      evidence_snippet: metric.context || null,
      model_id: modelId,
    });
  }

  // Store amounts
  for (const amt of data.amounts || []) {
    observations.push({
      client_id: clientId,
      document_id: documentId,
      object_type: data.doc_type || "business_doc",
      object_key: `${data.doc_type}::amount::${amt.description}`,
      field_name: "amount",
      field_value_text: String(amt.amount),
      field_value_json: amt,
      confidence: 0.85,
      evidence_snippet: amt.description || null,
      model_id: modelId,
    });
  }

  if (observations.length > 0) {
    const { error } = await supabase.from("observations").insert(observations);
    if (error) console.error("Business observation insert error:", error);
  }

  return observations.length;
}

// ─── Notify Telegram ────────────────────────────────────────────
async function notifyTelegram(documentName: string, docType: string, observationCount: number, clientName: string) {
  try {
    const SUPABASE_URL_ENV = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    await fetch(`${SUPABASE_URL_ENV}/functions/v1/notify-telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        document_name: documentName,
        doc_type: docType,
        observation_count: observationCount,
        client_name: clientName,
      }),
    });
  } catch (e) {
    console.error("Failed to send Telegram notification:", e);
  }
}

// ─── Main Handler ───────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { job_id } = await req.json().catch(() => ({ job_id: null }));

    // If no specific job, pick the next queued one
    let jobQuery = supabase
      .from("ingestion_jobs")
      .select("*, documents(*), clients(*)")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);

    if (job_id) {
      jobQuery = supabase
        .from("ingestion_jobs")
        .select("*, documents(*), clients(*)")
        .eq("id", job_id)
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

    console.log(`🔬 Processing: ${doc.file_name} (job: ${job.id})`);

    // Mark job as running
    await supabase
      .from("ingestion_jobs")
      .update({ status: "running", started_at: new Date().toISOString(), worker_id: "edge-worker" })
      .eq("id", job.id);

    // Update document status
    await supabase.from("documents").update({ status: "processing" }).eq("id", doc.id);

    try {
      // Download file from Drive
      const { content: base64, downloadMime } = await downloadDriveFile(doc.drive_file_id, doc.mime_type);
      console.log(`📥 Downloaded ${doc.file_name} (${downloadMime})`);

      // Update conversion status
      if (doc.conversion_status === "pending") {
        await supabase.from("documents").update({ conversion_status: "completed" }).eq("id", doc.id);
      }

      // Determine document type and analyze
      const creditReport = isCreditReport(doc.file_name);
      const prompt = creditReport ? CREDIT_REPORT_PROMPT : BUSINESS_DOC_PROMPT;

      console.log(`🧠 Analyzing with Gemini (${creditReport ? "credit report" : "business doc"})...`);
      const analysis = await callGemini(base64, downloadMime, prompt);

      // Store results
      let observationCount: number;
      const detectedDocType = analysis.doc_type || (creditReport ? "credit_report" : "unknown");

      if (creditReport) {
        observationCount = await storeCreditObservations(doc.client_id, doc.id, analysis);

        // Update document metadata
        await supabase.from("documents").update({
          doc_type: "credit_report",
          bureau: analysis.bureau || null,
          report_date: analysis.report_date || null,
          status: "completed",
        }).eq("id", doc.id);
      } else {
        observationCount = await storeBusinessObservations(doc.client_id, doc.id, analysis);

        await supabase.from("documents").update({
          doc_type: detectedDocType,
          status: "completed",
        }).eq("id", doc.id);
      }

      // Complete job
      await supabase
        .from("ingestion_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      // Notify via Telegram
      await notifyTelegram(doc.file_name, detectedDocType, observationCount, client?.name || "Unknown");

      const result = {
        job_id: job.id,
        document_id: doc.id,
        doc_type: detectedDocType,
        observations_created: observationCount,
        status: "completed",
      };

      console.log("✅ Processing complete:", result);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (processErr) {
      console.error(`❌ Processing error:`, processErr);

      // Mark job as failed
      await supabase
        .from("ingestion_jobs")
        .update({
          status: "failed",
          last_error: String(processErr),
          attempt_count: job.attempt_count + 1,
        })
        .eq("id", job.id);

      await supabase.from("documents").update({ status: "failed" }).eq("id", doc.id);

      throw processErr;
    }
  } catch (err) {
    console.error("💥 Process document failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Gemini Flash document parser for tax ingest (same contract as analyzeDocumentWithClaude).
 * Uses Google AI Studio API (generativelanguage.googleapis.com).
 */

const GEMINI_MODEL = Deno.env.get("GEMINI_TAX_MODEL") ?? "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface IncomeItem {
  source: string;
  type: string;
  amount: number;
  payer_name?: string;
  payer_ein?: string;
  date?: string;
}

interface ExpenseItem {
  category: string;
  description: string;
  amount: number;
  payee?: string;
  date?: string;
}

export interface ExtractedData {
  doc_type: string;
  classification: string;
  extracted_data: {
    income_items: IncomeItem[];
    expense_items: ExpenseItem[];
    payer_info: Record<string, string>;
  };
}

const EXTRACTION_PROMPT = `You are a tax document analyzer. Extract ALL financial data from this document.

Return ONLY valid JSON with this exact structure:
{
  "doc_type": "W-2" | "1099-NEC" | "1099-K" | "1099-MISC" | "1099-INT" | "1099-DIV" | "1099-B" | "1098" | "receipt" | "invoice" | "bank_statement" | "other",
  "classification": "income" | "expense" | "deduction" | "mixed",
  "extracted_data": {
    "income_items": [{ "source": "...", "type": "wages|contractor|interest|dividends|capital_gains|other", "amount": 0.00, "payer_name": "...", "payer_ein": "...", "date": "YYYY-MM-DD" }],
    "expense_items": [{ "category": "business|medical|charitable|education|home_office|vehicle|supplies|other", "description": "...", "amount": 0.00, "payee": "...", "date": "YYYY-MM-DD" }],
    "payer_info": { "name": "...", "ein": "...", "address": "..." }
  }
}

For bank statements: extract DEPOSITS as income_items and DEBITS/WITHDRAWALS as expense_items.
Categorize each transaction. Include the date, amount, and description for each.
Do NOT double-count transfers between accounts.`;

/**
 * Analyze a single document using Gemini Flash.
 * When customPrompt is set (from pickSystemPrompt), it is used as the system instruction.
 */
export async function analyzeDocumentWithGemini(
  base64Content: string,
  fileName: string,
  mimeType: string,
  customPrompt?: string,
): Promise<ExtractedData> {
  const apiKey = Deno.env.get("Frost_Gemini");
  if (!apiKey) throw new Error("Frost_Gemini not set");

  const systemPrompt = customPrompt ?? EXTRACTION_PROMPT;

  const parts: Array<Record<string, unknown>> = [];

  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  const isTextPlain =
    mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "text/csv";

  if (isTextPlain) {
    let decoded: string;
    try {
      decoded = atob(base64Content);
    } catch {
      decoded = base64Content;
    }
    parts.push({
      text: `Analyze this tax document (${fileName}). Content:\n\n${decoded}\n\nExtract all financial data.`,
    });
  } else if (isPdf) {
    parts.push({
      inline_data: { mime_type: "application/pdf", data: base64Content },
    });
    parts.push({
      text: `Analyze this tax document (${fileName}). Extract all financial data including dollar amounts, payer names, EINs, and dates.`,
    });
  } else if (isImage) {
    parts.push({
      inline_data: { mime_type: mimeType, data: base64Content },
    });
    parts.push({
      text: `Analyze this tax document (${fileName}). Extract all financial data including dollar amounts, payer names, EINs, and dates.`,
    });
  } else {
    let decodedText: string;
    try {
      decodedText = atob(base64Content);
    } catch {
      decodedText = base64Content;
    }
    parts.push({
      text: `Analyze this tax document (${fileName}). Content:\n\n${decodedText}\n\nExtract all financial data.`,
    });
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  };

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errText.slice(0, 2000)}`);
  }

  const result = await response.json();
  const textContent = result.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined;
  if (!textContent) throw new Error("No text response from Gemini");

  let parsed: Partial<ExtractedData>;
  try {
    parsed = JSON.parse(textContent);
  } catch {
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in Gemini response");
    parsed = JSON.parse(jsonMatch[0]);
  }

  return {
    doc_type: parsed.doc_type || "other",
    classification: parsed.classification || "mixed",
    extracted_data: {
      income_items: parsed.extracted_data?.income_items || [],
      expense_items: parsed.extracted_data?.expense_items || [],
      payer_info: parsed.extracted_data?.payer_info || { name: "", ein: "", address: "" },
    },
  };
}

/**
 * Process multiple documents in parallel batches (legacy helper; chunked ingest prefers one file per invocation).
 */
export async function analyzeDocumentsBatch(
  files: Array<{ base64: string; fileName: string; mimeType: string; fileId: string }>,
  concurrency = 4,
  customPrompt?: string,
): Promise<Array<{ fileId: string; fileName: string; result?: ExtractedData; error?: string }>> {
  const results: Array<{ fileId: string; fileName: string; result?: ExtractedData; error?: string }> = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    console.log(
      `[gemini] Processing batch ${Math.floor(i / concurrency) + 1}: ${batch.map((f) => f.fileName).join(", ")}`,
    );

    const batchResults = await Promise.allSettled(
      batch.map(async (file) => {
        const result = await analyzeDocumentWithGemini(file.base64, file.fileName, file.mimeType, customPrompt);
        return { fileId: file.fileId, fileName: file.fileName, result };
      }),
    );

    for (let bi = 0; bi < batchResults.length; bi++) {
      const settled = batchResults[bi];
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        const err = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        const file = batch[bi];
        console.error(`[gemini] Error processing ${file?.fileName}: ${err}`);
        results.push({ fileId: file?.fileId ?? "unknown", fileName: file?.fileName ?? "unknown", error: err });
      }
    }
  }

  return results;
}

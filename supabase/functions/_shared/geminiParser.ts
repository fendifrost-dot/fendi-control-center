/**
 * Gemini Flash document parser — fast, cheap bank statement extraction.
 * Uses Google AI Studio API (generativelanguage.googleapis.com).
 *
 * Cost: ~$0.01 per 12 statements vs ~$0.40 with Claude Sonnet.
 * Speed: ~1-3s per statement vs ~5-15s with Sonnet.
 */

const GEMINI_MODEL = "gemini-2.0-flash";
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

interface ExtractedData {
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
 * Accepts the same inputs/outputs as the old analyzeDocumentWithClaude.
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

  const isTextPlain = mimeType.startsWith("text/") || mimeType === "application/json";
  if (isTextPlain) {
    let decoded: string;
    try { decoded = atob(base64Content); } catch { decoded = base64Content; }
    parts.push({ text: `Analyze this tax document (${fileName}). Content:\n\n${decoded}\n\nExtract all financial data.` });
  } else {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Content,
      },
    });
    parts.push({
      text: `Analyze this tax document (${fileName}). Extract all financial data including dollar amounts, payer names, EINs, and dates.`,
    });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts }],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.1,
    },
  };

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errText}`);
  }

  const result = await response.json();

  const textContent = result.candidates?.[0]?.content?.parts?.[0]?.text;
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
 * Process multiple documents in parallel batches.
 * Avoids memory spikes by limiting concurrency.
 */
export async function analyzeDocumentsBatch(
  files: Array<{ base64: string; fileName: string; mimeType: string; fileId: string }>,
  concurrency = 4,
  customPrompt?: string,
): Promise<Array<{ fileId: string; fileName: string; result?: ExtractedData; error?: string }>> {
  const results: Array<{ fileId: string; fileName: string; result?: ExtractedData; error?: string }> = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    console.log(`[gemini] Processing batch ${Math.floor(i / concurrency) + 1}: ${batch.map(f => f.fileName).join(", ")}`);

    const batchResults = await Promise.allSettled(
      batch.map(async (file) => {
        const result = await analyzeDocumentWithGemini(file.base64, file.fileName, file.mimeType, customPrompt);
        return { fileId: file.fileId, fileName: file.fileName, result };
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        const err = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        const idx = batchResults.indexOf(settled);
        const file = batch[idx];
        console.error(`[gemini] Error processing ${file?.fileName}: ${err}`);
        results.push({ fileId: file?.fileId ?? "unknown", fileName: file?.fileName ?? "unknown", error: err });
      }
    }
  }

  return results;
}

import type { PdfPage } from "./pdfSplitter.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_TAX_MODEL") ?? "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function ocrPage(page: PdfPage): Promise<string> {
  const apiKey = Deno.env.get("Frost_Gemini");
  if (!apiKey) return "";
  const b64 = btoa(String.fromCharCode(...page.pdfBuffer));
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: "application/pdf", data: b64 } },
        { text: "Extract only readable text from this single statement page. Return plain text only." },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  };
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return "";
  const json = await res.json();
  return String(json.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

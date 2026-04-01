const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const DEFAULT_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;

type SimpleSchema = {
  required?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
}

function parseJsonText<T>(raw: string): T {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(withoutFence) as T;
}

function assertSchema(value: unknown, schema?: SimpleSchema): void {
  if (!schema?.required?.length) return;
  if (!value || typeof value !== "object") {
    throw new Error("OpenAI JSON response is not an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of schema.required) {
    if (!(key in record)) {
      throw new Error(`OpenAI JSON missing required key: ${key}`);
    }
  }
}

export async function callGPT(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI API error ${resp.status}: ${errText.slice(0, 800)}`);
      }
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("OpenAI response had no text content");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`OpenAI request failed after retries: ${String(lastErr)}`);
}

export async function callGPTJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  schema?: SimpleSchema,
  maxTokens = 4096,
): Promise<T> {
  const raw = await callGPT(
    `${systemPrompt}\nRespond with valid JSON only. No markdown fences.`,
    userPrompt,
    maxTokens,
  );
  const parsed = parseJsonText<T>(raw);
  assertSchema(parsed, schema);
  return parsed;
}

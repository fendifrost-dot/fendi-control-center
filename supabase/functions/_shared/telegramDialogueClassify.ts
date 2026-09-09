/**
 * Gemini-backed dialogue routing — paraphrases OK; regex in telegramNaturalLanguage.ts is fallback only.
 */

export type EarlyDialogueIntent = "ping" | "help" | "hub_status" | "mac_status" | "mac_run" | "none";

const VALID_INTENTS = new Set<EarlyDialogueIntent>([
  "ping",
  "help",
  "hub_status",
  "mac_status",
  "mac_run",
  "none",
]);

function parseIntentLabel(raw: string): EarlyDialogueIntent | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
  if (VALID_INTENTS.has(cleaned as EarlyDialogueIntent)) return cleaned as EarlyDialogueIntent;
  return null;
}

/** Quick operational intent when regex did not match — not for credit/tax/workflows. */
export async function classifyEarlyDialogueIntent(
  userMessage: string,
  options?: { timeoutMs?: number },
): Promise<EarlyDialogueIntent | null> {
  const geminiKey = Deno.env.get("Frost_Gemini") ?? "";
  if (!geminiKey) return null;

  const msg = userMessage.trim().slice(0, 600);
  if (!msg || msg.startsWith("/")) return null;

  const prompt = `You route Telegram messages for a personal control-center bot.
Pick exactly ONE label for the user's intent. They may phrase it any way — match meaning, not exact words.

Labels:
- PING — checking the bot is alive, responding, or reachable (not system diagnostics)
- HELP — wants to know what the bot can do or how to use it
- HUB_STATUS — wants hub/system/bridge health, failures, queue, "is anything broken" (NOT a specific client's credit/tax)
- MAC_STATUS — wants to know if their Mac/computer/laptop remote bridge is online (NOT run a command)
- MAC_RUN — wants to execute/run something ON their Mac (shell, git, Cursor, Claude, open URL)
- NONE — general chat, Q&A, credit/tax/client work, playlists, or anything needing the full task pipeline

User message:
"${msg.replace(/"/g, "'")}"

Reply with ONLY one label: PING, HELP, HUB_STATUS, MAC_STATUS, MAC_RUN, or NONE`;

  const timeoutMs = options?.timeoutMs ?? 2500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 24 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[DIALOGUE_CLASSIFY] Gemini status:", res.status);
      return null;
    }
    const json = await res.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const label = rawText.split(/\s+/)[0] ?? "";
    const mapped = parseIntentLabel(label.replace(/-/g, "_"));
    if (mapped && mapped !== "none") {
      console.log(JSON.stringify({ event: "dialogue_classify", intent: mapped, preview: msg.slice(0, 80) }));
    }
    return mapped;
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.error("[DIALOGUE_CLASSIFY] Error:", e);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

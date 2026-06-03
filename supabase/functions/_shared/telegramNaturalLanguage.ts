/**
 * Natural-language intent detection for Telegram (minimal slash syntax).
 */

export function normalizeTelegramText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(@\w+)\s+/i, "") // optional leading @BotName
    .replace(/(@\w+)$/i, "") // trailing bot mention
    .trim();
}

/** User wants connectivity / webhook check */
export function isConnectivityCheck(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/ping" || lower === "ping" || lower === "pong test") return true;
  return /\b(are you there|you there|connectivity|still alive|hub online)\b/.test(lower);
}

/** Mac bridge health only (not shell work) */
export function isMacBridgeStatusCheck(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/mac" || lower === "/mac status" || lower === "/computer" || lower === "/computer status") {
    return true;
  }
  if (/\bmac\s+status\b/.test(lower) || /\bbridge\s+status\b/.test(lower)) return true;
  if (/\b(is|check)\b.*\b(mac|computer|bridge)\b.*\b(online|connected|up|alive)\b/.test(lower)) return true;
  if (/\b(mac|computer)\b.*\b(online|connected)\b/.test(lower) && !/\b(run|execute|git|npm)\b/.test(lower)) {
    return true;
  }
  return false;
}

/** Hub / control-center status (not tax client status) */
export function isHubStatusRequest(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/status" || lower === "status" || lower === "system status") return true;
  if (/\b(hub|control center|control hub)\s+status\b/.test(lower)) return true;
  if (/\bwhat'?s?\s+(the\s+)?(hub\s+)?status\b/.test(lower)) return true;
  if (/\b(system\s+)?status\s+check\b/.test(lower)) return true;
  if (lower === "how are things" || lower === "what's broken") return true;
  return false;
}

export function isHelpRequest(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/help" || lower === "help" || lower === "help me") return true;
  if (/^what can you do\??$/.test(lower)) return true;
  if (/^how do i (use|talk to) (you|this|the bot)\??$/.test(lower)) return true;
  if (/\b(show|list)\s+(commands|workflows)\b/.test(lower) && !/\b(run|execute)\b/.test(lower)) {
    return true;
  }
  return false;
}

/** Message is a slash command */
export function isSlashMessage(text: string): boolean {
  const n = normalizeTelegramText(text);
  return n.startsWith("/") && !n.startsWith("//");
}

export function slashCommandBase(text: string): string {
  const first = normalizeTelegramText(text).split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/@\w+$/, "");
}

const KNOWN_SLASH = new Set([
  "/start",
  "/help",
  "/ping",
  "/status",
  "/metrics",
  "/triage",
  "/workflows",
  "/model",
  "/do",
  "/tax",
  "/resend_failed",
  "/mac",
  "/computer",
  "/version",
  "/hub",
]);

export function isUnknownSlashCommand(text: string): boolean {
  if (!isSlashMessage(text)) return false;
  const base = slashCommandBase(text);
  if (KNOWN_SLASH.has(base)) return false;
  if (base.startsWith("/mac") || base.startsWith("/computer")) return false;
  if (base.startsWith("/do") || base.startsWith("/tax") || base.startsWith("/model")) return false;
  if (base.startsWith("/resend")) return false;
  return true;
}

/** Broad execution intent for cloud workflows (Lane 1), not Mac bridge */
export function hasNaturalLanguageExecutionIntent(lower: string): boolean {
  const n = lower.trim();
  if (/\b(on|from)\s+(?:my\s+)?(?:mac|computer)\b/.test(n)) return false;
  if (/\bmy\s+(?:mac|computer)\b/.test(n) && /\b(run|execute|git|npm|cursor|claude)\b/.test(n)) return false;

  if (["run ", "execute ", "trigger ", "start ", "do "].some((p) => n.startsWith(p))) return true;
  if (/\bplease\s+(execute|run|do|handle)\b/.test(n)) return true;
  if (/\bgo\s+ahead(?:\s+and)?\s+(execute|run|do)\b/.test(n)) return true;
  if (/\bjust\s+(execute|run|do)\b/.test(n)) return true;
  if (/\b(execute|run|do)\s+(it|that|this|now|again)\b/.test(n)) return true;
  if (/\bcan you\s+(run|execute|do)\b/.test(n)) return true;
  if (/\bcould you\s+(run|execute|do)\b/.test(n)) return true;
  if (/\bi need you to\b/.test(n)) return true;
  if (/\btake care of\b/.test(n)) return true;

  // Domain task phrases (no "run" required)
  if (
    /\b(ingest|import|sync|analyze|analyse|generate|create|build|dispute|pitch|search)\b/.test(n) &&
    /\b(client|credit|tax|playlist|guardian|compass|guardian|drive|return|bureau|letter)\b/.test(n)
  ) {
    return true;
  }
  if (/\bfind\s+playlist\b/.test(n) || /\bplaylist\s+opportunit/.test(n)) return true;
  if (/\bcredit\s+(analysis|report|dispute)/.test(n)) return true;
  if (/\bgenerate\s+tax\b/.test(n) || /\btax\s+(docs|documents|return)\b/.test(n)) return true;

  return false;
}

export const NATURAL_LANGUAGE_HELP = `Talk to me like a person — no slash commands required.

• Mac: "is my mac online", "on my mac run git status", "use my computer to open Cursor"
• Hub: "system status", "what's the status", "help"
• Work: "run drive ingest for Zeus", "analyze credit for Jabril", "generate tax docs for Smith"
• Chat: ask questions normally (no "run") for planning and explanations

Optional shortcuts still work: /ping, /status, /mac status`;

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
  if (/^\s*(hey|hello|hi)\b/.test(lower) && /\b(there|bot|fendi)\b/.test(lower) && lower.length < 80) return true;
  return /\b(are you (there|up|awake)|you there|still (alive|there|up)|bot (alive|working|up)|responding)\b/.test(lower) ||
    /\b(connectivity|wake up|you\s+working)\b/.test(lower);
}

/** Mac bridge health only (not shell work) */
export function isMacBridgeStatusCheck(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/mac" || lower === "/mac status" || lower === "/computer" || lower === "/computer status") {
    return true;
  }
  if (/\bmac\s+status\b/.test(lower) || /\bbridge\s+status\b/.test(lower)) return true;
  if (/\b(is|check|can you see)\b.*\b(mac|macbook|computer|laptop|bridge)\b.*\b(online|connected|up|alive|reachable)\b/.test(lower)) return true;
  if (/\b(mac|macbook|computer|laptop)\b.*\b(online|connected|reachable|up)\b/.test(lower) && !/\b(run|execute|git|npm|pull|push)\b/.test(lower)) {
    return true;
  }
  if (/\bremote\s+(mac|computer|machine)\b/.test(lower) && /\b(status|online|connected)\b/.test(lower)) return true;
  return false;
}

/** Hub / control-center status (not tax client status) */
export function isHubStatusRequest(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/status" || lower === "status" || lower === "system status") return true;
  if (/\b(hub|control center|control hub)\s+status\b/.test(lower)) return true;
  if (/\bwhat'?s?\s+(the\s+)?(hub\s+)?status\b/.test(lower)) return true;
  if (/\b(system\s+)?status\s+check\b/.test(lower)) return true;
  if (/\b(how('s| is)|is)\s+(everything|the hub|the system)\b/.test(lower)) return true;
  if (/\b(anything|something)\s+broken\b/.test(lower) || /\bhealth\s+check\b/.test(lower)) return true;
  if (/\bhow are things\b/.test(lower) || /\bwhat'?s broken\b/.test(lower)) return true;
  return false;
}

export function isHelpRequest(text: string): boolean {
  const lower = normalizeTelegramText(text).toLowerCase();
  if (lower === "/help" || /^help\b/.test(lower) || /\b(need help|i'?m stuck|not sure how)\b/.test(lower)) return true;
  if (/\bwhat can you do\b/.test(lower) || /\bhow do i (use|talk to|work with)\b/.test(lower)) return true;
  if (/\b(show|list)\s+(commands|workflows|what you can)\b/.test(lower) && !/\b(run|execute)\b/.test(lower)) {
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
  if (/\bcredit\s+(analysis|report|dispute|pull|file)/.test(n)) return true;
  if (/\b(dispute|fix|clean up|work on)\b.*\bcredit\b/.test(n)) return true;
  if (/\b(needs?|wants?|help with|work on)\b.*\bcredit\b/.test(n)) return true;
  if (/\b(client|customer)\b.*\bcredit\b/.test(n) && /\b(need|want|help|work|look)\b/.test(n)) return true;
  if (/\bgenerate\s+tax\b/.test(n) || /\btax\s+(docs|documents|return|prep|preparation)\b/.test(n)) return true;
  if (/\b(prepare|file|do)\b.*\btax\b/.test(n)) return true;

  return false;
}


/** True small-talk / explain-only — skip workflow Gemini classify */
export function isClearlyConversational(lower: string): boolean {
  const n = lower.trim();
  if (!n) return true;
  if (/^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|got it|sounds good)\b/i.test(n)) return true;
  if (/^(what is|what's|how does|how do|why is|explain|describe|tell me about|can you explain)\b/i.test(n)) {
    return !hasNaturalLanguageExecutionIntent(n);
  }
  return false;
}

export const NATURAL_LANGUAGE_HELP = `Talk to me in your own words — you do NOT need exact phrases or slash commands.

• Mac bridge: ask if your Mac/laptop is connected, or tell me what to run there
• Hub health: ask if anything is broken, how things are going, or for a status check
• Real work: describe credit, tax, Drive, playlists, etc. the way you'd tell a person
• Chat: questions and planning without saying "run" — I'll answer conversationally

Optional shortcuts: /ping, /status, /help, /mac (only if you like them)`;

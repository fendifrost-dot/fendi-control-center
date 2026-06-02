/** Remote Control Hub — enqueue + safety helpers (cloud side). */

export type RemoteCommandType = "shell" | "cursor_agent" | "claude" | "open_url" | "notify" | "ping";

export interface RemoteCommandPayload {
  /** Shell command string or agent prompt */
  text?: string;
  cwd?: string;
  url?: string;
  title?: string;
  timeout_sec?: number;
}

const BLOCKED_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

export function parseMacTelegramCommand(text: string): {
  command_type: RemoteCommandType;
  payload: RemoteCommandPayload;
} | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "/mac" || lower === "/mac status" || lower === "/computer" || lower === "/computer status") {
    return { command_type: "ping", payload: { text: "status" } };
  }

  const macPrefix = trimmed.match(/^\/(?:mac|computer)\s+(.+)$/is);
  if (macPrefix) {
    return parseMacBody(macPrefix[1].trim());
  }

  const runOnMac = trimmed.match(/^(?:run\s+on\s+(?:my\s+)?(?:mac|computer)|mac:)\s*[:\-]?\s*(.+)$/is);
  if (runOnMac) {
    return parseMacBody(runOnMac[1].trim());
  }

  return null;
}

function parseMacBody(body: string): { command_type: RemoteCommandType; payload: RemoteCommandPayload } | null {
  if (!body) return null;

  const cursorMatch = body.match(/^cursor\s+(.+)$/is);
  if (cursorMatch) {
    return { command_type: "cursor_agent", payload: { text: cursorMatch[1].trim() } };
  }

  const claudeMatch = body.match(/^claude\s+(.+)$/is);
  if (claudeMatch) {
    return { command_type: "claude", payload: { text: claudeMatch[1].trim() } };
  }

  const openMatch = body.match(/^open\s+(https?:\/\/.+)$/is);
  if (openMatch) {
    return { command_type: "open_url", payload: { url: openMatch[1].trim() } };
  }

  const notifyMatch = body.match(/^notify\s+(.+)$/is);
  if (notifyMatch) {
    return { command_type: "notify", payload: { text: notifyMatch[1].trim() } };
  }

  return { command_type: "shell", payload: { text: body } };
}

export function assertShellAllowed(command: string): string | null {
  const c = command.trim();
  if (!c) return "Empty command";
  if (c.length > 4000) return "Command too long (max 4000 chars)";
  for (const re of BLOCKED_SHELL_PATTERNS) {
    if (re.test(c)) return `Blocked pattern: ${re.source}`;
  }
  return null;
}

export function formatRemoteResultForTelegram(
  commandId: string,
  commandType: string,
  result: { stdout?: string; stderr?: string; exit_code?: number; message?: string },
  error?: string | null,
): string {
  if (error) {
    return `🖥️ *Mac bridge* — failed\n\`${commandId.slice(0, 8)}\` (${commandType})\n\n${error}`;
  }
  const parts: string[] = [
    `🖥️ *Mac bridge* — ${commandType}`,
    `\`${commandId.slice(0, 8)}\``,
  ];
  if (result.message) parts.push("", result.message);
  if (result.stdout) {
    const out = result.stdout.length > 3500 ? result.stdout.slice(0, 3500) + "\n…(truncated)" : result.stdout;
    parts.push("", "```", out, "```");
  }
  if (result.stderr) {
    const err = result.stderr.length > 800 ? result.stderr.slice(0, 800) + "…" : result.stderr;
    parts.push("", `_stderr:_`, "```", err, "```");
  }
  if (typeof result.exit_code === "number") parts.push("", `exit: ${result.exit_code}`);
  return parts.join("\n");
}

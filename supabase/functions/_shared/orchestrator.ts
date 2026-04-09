/**
 * Claude orchestrator — tool selection via Anthropic Messages API (tool_use).
 * Used by telegram-webhook when ANTHROPIC_API_KEY is set (falls back to Grok otherwise).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";
const ORCH_TIMEOUT_MS = Number(Deno.env.get("CLAUDE_ORCHESTRATOR_TIMEOUT_MS") || "120000");

export type ToolDefForOrchestrator = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive: boolean;
};

export type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Map Control Center tool defs to Anthropic tool schema. */
export function toAnthropicTools(defs: ToolDefForOrchestrator[]): AnthropicToolDefinition[] {
  return defs.map((t) => ({
    name: t.name,
    description:
      t.description +
      (t.destructive ? " [DESTRUCTIVE — requires user confirmation before execution]" : ""),
    input_schema: t.parameters,
  }));
}

export function anthropicApiKeyConfigured(): boolean {
  return Boolean(Deno.env.get("ANTHROPIC_API_KEY")?.trim());
}

type MessagesContentBlock = Record<string, unknown>;

type MessagesResponse = {
  content?: MessagesContentBlock[];
  stop_reason?: string;
};

/**
 * Single-turn tool selection: Claude may return one or more tool_use blocks (or text only).
 * Does not run tools — caller executes and may implement a follow-up round later.
 */
export async function callClaudeWithTools(params: {
  system: string;
  user: string;
  tools: AnthropicToolDefinition[];
  maxTokens?: number;
}): Promise<{ text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const maxTokens = params.maxTokens ?? 4096;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ORCH_TIMEOUT_MS);

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: maxTokens,
        system: params.system,
        tools: params.tools,
        messages: [{ role: "user", content: params.user }],
      }),
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      throw new Error(`Anthropic ${resp.status}: ${rawText.slice(0, 1200)}`);
    }

    const data = JSON.parse(rawText) as MessagesResponse;
    const content = Array.isArray(data.content) ? data.content : [];

    let text = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = block.input;
        const args =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        toolCalls.push({ name: block.name, args });
      }
    }

    return { text: text.trim(), toolCalls };
  } finally {
    clearTimeout(timer);
  }
}

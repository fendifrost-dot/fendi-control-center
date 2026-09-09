import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ key_present: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = {
    model: "gpt-6-astra",
    input:
      "Do not click or type. If a computer tool is available, request only a screenshot; otherwise reply exactly: NO_COMPUTER_TOOL",
    tools: [{ type: "computer" }],
    max_output_tokens: 256,
    reasoning: { effort: "low" },
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  const status = resp.status;
  const json = await resp.json().catch(() => ({} as Record<string, unknown>));

  const out = Array.isArray((json as any)?.output) ? (json as any).output : [];
  const types = out.map((o: any) => o?.type);
  const hasComputerCall = types.some((t: string) => typeof t === "string" && t.includes("computer"));
  const text = out
    .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
    .map((c: any) => c?.text)
    .filter((t: unknown) => typeof t === "string")
    .join(" ")
    .slice(0, 200);

  const err = (json as any)?.error
    ? {
        type: (json as any).error.type ?? null,
        code: (json as any).error.code ?? null,
        message: String((json as any).error.message ?? "").slice(0, 400),
      }
    : null;

  return new Response(
    JSON.stringify({
      status,
      output_types: types,
      computer_call_present: hasComputerCall,
      text_preview: text,
      error: err,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

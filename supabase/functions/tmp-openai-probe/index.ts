import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function sanitize(obj: unknown) {
  try {
    const s = JSON.stringify(obj);
    return JSON.parse(s.slice(0, 4000).length === s.length ? s : JSON.stringify({ truncated: s.slice(0, 4000) }));
  } catch {
    return { unparsable: true };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const key = Deno.env.get("OPENAI_API_KEY");
  const report: Record<string, unknown> = { key_present: Boolean(key && key.trim()) };

  if (!key) {
    return new Response(JSON.stringify(report), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  // 1) model lookup
  try {
    const r = await fetch("https://api.openai.com/v1/models/gpt-6-astra", { headers: auth });
    const body = await r.json().catch(() => ({}));
    report.models_get = {
      status: r.status,
      id: (body as any)?.id ?? null,
      error: (body as any)?.error
        ? {
            type: (body as any).error.type,
            code: (body as any).error.code,
            message: String((body as any).error.message ?? "").slice(0, 300),
          }
        : null,
    };
  } catch (e) {
    report.models_get = { error: String(e).slice(0, 300) };
  }

  const modelsOk = (report.models_get as any)?.status === 200;

  // 2) responses call
  if (modelsOk) {
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "gpt-6-astra",
          input: "Reply exactly: ASTRA_ACCESS_CONFIRMED",
          max_output_tokens: 2048,
        }),
      });
      const body = await r.json().catch(() => ({}));
      const text =
        (body as any)?.output_text ??
        (body as any)?.output?.flatMap((o: any) => o?.content ?? [])?.map((c: any) => c?.text ?? "").join("") ??
        "";
      report.responses = {
        status: r.status,
        confirmed: String(text).includes("ASTRA_ACCESS_CONFIRMED"),
        text_preview: String(text).slice(0, 120),
        error: (body as any)?.error
          ? {
              type: (body as any).error.type,
              code: (body as any).error.code,
              message: String((body as any).error.message ?? "").slice(0, 300),
            }
          : null,
      };
    } catch (e) {
      report.responses = { error: String(e).slice(0, 300) };
    }

    // 3) computer tool probe
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "gpt-6-astra",
          input: "Say OK. Do not use any tool.",
          max_output_tokens: 2048,
          tools: [
            {
              type: "computer_use_preview",
              display_width: 1024,
              display_height: 768,
              environment: "mac",
            },
          ],
        }),
      });
      const body = await r.json().catch(() => ({}));
      report.computer_tool = {
        status: r.status,
        accepted: r.status === 200,
        error: (body as any)?.error
          ? {
              type: (body as any).error.type,
              code: (body as any).error.code,
              message: String((body as any).error.message ?? "").slice(0, 400),
            }
          : null,
      };
    } catch (e) {
      report.computer_tool = { error: String(e).slice(0, 300) };
    }
  }

  return new Response(JSON.stringify(sanitize(report)), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});

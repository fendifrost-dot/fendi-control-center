import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { checkProxyAuth, corsHeaders, finishLog, jsonError, jsonOk, startLog } from "../_shared/video-providers/proxy.ts";
import { parseInput } from "./contract.ts";
import { run } from "./run.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("METHOD_NOT_ALLOWED", "Use POST", 405);
  const auth = checkProxyAuth(req); if (!auth.ok) return auth.response;
  let input;
  try { input = parseInput(await req.json()); }
  catch (e) { return jsonError("INVALID_REQUEST", e instanceof Error ? e.message : "invalid_json", 400); }
  const key = Deno.env.get("Frost_Gemini")?.trim() ?? "";
  if (!key) return jsonError("PROVIDER_KEY_NOT_CONFIGURED", "Frost_Gemini is not configured in Control Center.", 503);
  if (input.dryRun) return jsonOk(await run(input, key));
  const log = await startLog({ provider: "gemini", toolName: "image-providers-gemini-generate", audit: { avt_user_id: input.avt_user_id, avt_project_id: input.avt_project_id }, modelVariant: input.model, promptText: input.prompt, extraArgs: { jobRowId: input.jobRowId, resolution: input.resolution, aspectRatio: input.aspectRatio, references: input.references.map(({ label, role }) => ({ label, role })) } });
  if (!log.logId) return jsonError("AUDIT_UNAVAILABLE", "No provider request was submitted.", 503);
  const result = await run(input, key);
  // Never log reference URLs, image bytes, or credentials.
  const { images: _images, ...evidence } = result;
  // An audit row left "attempted" after a completed call looks like a lost answer; say when that happened.
  const auditFinalized = await finishLog(log.logId, result.ok ? "succeeded" : "failed", { startedAt: log.startedAt, responseJson: evidence, httpStatus: 200 });
  return jsonOk({ ...result, requestId: log.requestId, auditFinalized });
});

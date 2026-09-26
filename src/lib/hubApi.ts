import { supabase } from "@/integrations/supabase/client";

/**
 * Calls a hub action through the remote-bridge-api edge function.
 * Shape: { action, ...params } -> JSON payload.
 */
export async function callHubFn<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("remote-bridge-api", {
    body: { action, ...params },
  });
  if (error) throw new Error(error.message);
  if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
    const err = (data as Record<string, unknown>).error;
    if (err) throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  return data as T;
}

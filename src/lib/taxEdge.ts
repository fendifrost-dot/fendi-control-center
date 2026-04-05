import { supabase } from "@/integrations/supabase/client";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export type InvokeTaxEdgeOptions = {
  /** Allow falling back to the anon key when no user session (default false — tax actions require sign-in). */
  allowAnon?: boolean;
};

export async function invokeTaxEdge<T = unknown>(
  functionName: string,
  body: Record<string, unknown>,
  options?: InvokeTaxEdgeOptions,
): Promise<T> {
  const { data: sess } = await supabase.auth.getSession();
  const userJwt = sess.session?.access_token;
  if (!userJwt && !options?.allowAnon) {
    throw new Error("Sign in required to run this tax action.");
  }
  const token = userJwt ?? anon;
  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error((parsed.error as string) || text || res.statusText);
  }
  return parsed as T;
}

export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

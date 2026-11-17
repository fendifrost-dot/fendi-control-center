import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { safeReturnPath } from "@/lib/safeReturnPath";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function authorizeUrl(): string {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/control-center-mcp/oauth/authorize`;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

/**
 * Owner consent for the Control Center MCP connector.
 * The edge function cannot serve this page (Supabase rewrites text/html),
 * so ChatGPT and Claude land here. Approval posts the existing session.
 * The page never asks for a token, client secret, or API key.
 */
export default function McpAuthorizePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "S256";
  const scope = params.get("scope") || "control_center";
  const resource = params.get("resource") || "";
  const redirectHost = hostOf(redirectUri);
  const ready = Boolean(clientId && redirectUri && codeChallenge && redirectHost);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  function returnHere() {
    const from = safeReturnPath(`/oauth/mcp-authorize${window.location.search}`);
    navigate("/login", { state: { from } });
  }

  async function post(decision: "authorize" | "cancel") {
    setBusy(true);
    setError("");
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const publishable = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
      if (publishable) headers.apikey = publishable;
      if (decision === "authorize") {
        if (!session?.access_token) {
          returnHere();
          return;
        }
        headers.authorization = `Bearer ${session.access_token}`;
      }
      const response = await fetch(authorizeUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope,
          resource,
          decision,
        }),
      });
      const body = await response.json().catch(() => ({} as { error_description?: unknown; redirect_to?: unknown }));
      if (!response.ok) {
        const code = typeof body.error_description === "string" ? body.error_description : "";
        const known: Record<string, string> = {
          only_owner_may_authorize: "This session is not a Control Center owner.",
          invalid_session: "Sign in again, then approve.",
          owner_session_required: "Sign in again, then approve.",
          owner_check_failed: "The owner list could not be read.",
        };
        setError(known[code] ?? "Authorization was refused.");
        setBusy(false);
        return;
      }
      if (typeof body.redirect_to === "string" && body.redirect_to.startsWith("https://")) {
        window.location.href = body.redirect_to;
        return;
      }
      if (typeof body.redirect_to === "string" && body.redirect_to.startsWith("http://127.0.0.1")) {
        window.location.href = body.redirect_to;
        return;
      }
      if (typeof body.redirect_to === "string" && body.redirect_to.startsWith("http://localhost")) {
        window.location.href = body.redirect_to;
        return;
      }
      setError("Authorization did not return a redirect.");
    } catch {
      setError("Authorization could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Connect Control Center</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <p>
            This grants the <span className="font-medium">control_center</span> scope: read the Muse
            workboard, missions, and posts; post status, reports, and comments; read and acknowledge
            alerts. It does not mint API tokens or reveal secrets.
          </p>
          <p>Only a Control Center owner session can approve. {redirectHost ? `The connector will return to ${redirectHost}.` : null}</p>
          {session === undefined ? <p className="text-muted-foreground">Checking session…</p> : null}
          {session === null ? (
            <Button type="button" className="w-full" onClick={returnHere}>Sign in to approve</Button>
          ) : (
            <div className="flex gap-3">
              <Button type="button" disabled={busy || !ready} onClick={() => post("authorize")}>
                {busy ? "Approving…" : "Approve"}
              </Button>
              <Button type="button" variant="outline" disabled={busy || !redirectUri} onClick={() => post("cancel")}>
                Cancel
              </Button>
            </div>
          )}
          {error ? <p className="text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

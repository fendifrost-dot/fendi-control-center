import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";

type Props = {
  children: ReactNode;
  /** When false, only authenticated users see children; others see nothing (useful inside larger layouts). */
  showSignedOutFallback?: boolean;
};

/**
 * Blocks children until Supabase session is known, then renders children only if authenticated.
 */
export function RequireSession({ children, showSignedOutFallback = true }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Checking session…
      </div>
    );
  }

  if (!session) {
    if (!showSignedOutFallback) return null;
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Sign in required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Use your organization&apos;s Supabase Auth sign-in (magic link, OAuth, or email) to access this
          area. If you are not a team member, close this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
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

  const location = useLocation();

  if (!session) {
    if (!showSignedOutFallback) return null;
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

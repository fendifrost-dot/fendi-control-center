import { Link, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Moon, Sun, LogOut } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";
import { RequireSession } from "@/components/auth/RequireSession";

export function TaxShell() {
  const { theme, setTheme } = useTheme();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(() => void supabase.auth.signOut(), []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <nav className="flex items-center gap-6">
            <Link to="/clients" className="text-lg font-semibold tracking-tight">
              Tax Prep
            </Link>
            <Link
              to="/clients"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Clients
            </Link>
            <Link
              to="/ops"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Ops
            </Link>
          </nav>
          <div className="flex items-center gap-1">
            {session?.user?.email && (
              <span className="mr-2 hidden max-w-[10rem] truncate text-xs text-muted-foreground sm:inline">
                {session.user.email}
              </span>
            )}
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={signOut}>
              <LogOut className="mr-1 h-4 w-4" />
              Sign out
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
          </div>
        </div>
      </header>
      <main className="container max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

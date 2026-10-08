/**
 * Muse layout. Mirrors TaxShell so the Muse module reads as part of Control Hub
 * rather than a second product: same header conventions, same session guard,
 * same theme toggle, same way back to the Hub cover.
 */
import { Link, NavLink, Outlet } from "react-router-dom";
import { Home, LogOut, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { RequireSession } from "@/components/auth/RequireSession";
import { cn } from "@/lib/utils";

const MUSE_NAV: Array<{ to: string; label: string }> = [
  { to: "/muse", label: "Brief" },
  { to: "/muse/missions", label: "Missions" },
  { to: "/muse/daily", label: "Daily 1%" },
  { to: "/muse/agents", label: "Agent queue" },
  { to: "/muse/feed", label: "Work feed" },
  { to: "/muse/reports", label: "Reports" },
  { to: "/muse/impact", label: "Impact" },
  { to: "/muse/portfolio", label: "Portfolio" },
  { to: "/muse/loops", label: "Open loops" },
  { to: "/muse/improvements", label: "1% ledger" },
  { to: "/muse/sources", label: "Sources" },
  { to: "/muse/systems", label: "Systems" },
];

export function MuseShell() {
  const { theme, setTheme } = useTheme();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(() => void supabase.auth.signOut(), []);

  return (
    <RequireSession>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="container flex min-h-14 max-w-6xl items-center justify-between gap-4 px-4 py-2">
            <nav className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-5">
              <Link
                to="/"
                className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <Home className="h-4 w-4" />
                Home
              </Link>
              <Link to="/muse" className="text-lg font-semibold tracking-tight">
                Muse
              </Link>
              {MUSE_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/muse"}
                  className={({ isActive }) =>
                    cn(
                      "text-sm transition-colors hover:text-foreground",
                      isActive ? "font-medium text-foreground" : "text-muted-foreground",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-1">
              {session?.user?.email && (
                <span className="mr-2 hidden max-w-[10rem] truncate text-xs text-muted-foreground sm:inline">
                  {session.user.email}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={signOut}
              >
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
        <footer className="container max-w-6xl px-4 pb-10">
          <p className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
            Muse is the executive intelligence layer. Domain systems own their truth; Control Center records missions, coordination, evidence and measured improvement. Anything marked{" "}
            <span className="font-mono">SOURCE EXISTS ACCESS NEEDED</span> is real but not connected.
          </p>
        </footer>
      </div>
    </RequireSession>
  );
}

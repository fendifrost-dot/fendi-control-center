import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, Home } from "lucide-react";
import type { ReactNode } from "react";
import { RequireSession } from "@/components/auth/RequireSession";
import { cn } from "@/lib/utils";
import { hub, STATE_STYLE, type HubAgent } from "@/lib/agentHub";

/** Full-height app frame that respects the iPhone notch and home indicator when installed. */
export function AgentHubShell({ title, back, actions, children, footer }: {
  title: ReactNode;
  back?: string;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RequireSession>
      <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
        <header
          className="sticky top-0 z-40 border-b border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
            <Link
              to={back ?? "/"}
              aria-label={back ? "Back" : "Home"}
              className="-ml-2 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              {back ? <ArrowLeft className="h-5 w-5" /> : <Home className="h-5 w-5" />}
            </Link>
            <div className="min-w-0 flex-1 truncate text-base font-semibold">{title}</div>
            {actions}
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-6 pt-3">{children}</main>
        {footer && (
          <div
            className="sticky bottom-0 z-30 border-t border-border/70 bg-background/95 backdrop-blur"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="mx-auto max-w-3xl px-3 py-2">{footer}</div>
          </div>
        )}
      </div>
    </RequireSession>
  );
}

export function useAgents() {
  return useQuery({
    queryKey: ["agent-hub", "agents"],
    queryFn: async () => (await hub<{ agents: HubAgent[] }>("agents")).agents,
    refetchInterval: 30_000,
  });
}

export function StateDot({ state, className }: { state: HubAgent["effective"]["state"]; className?: string }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATE_STYLE[state].dot, className)} />;
}

export function agentName(agents: HubAgent[] | undefined, key: string): string {
  if (key === "agent-hub") return "Control Center";
  return agents?.find((a) => a.key === key)?.display_name ?? key;
}

export function Initial({ name, human }: { name: string; human?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        human ? "bg-foreground text-background" : "bg-muted text-foreground",
      )}
    >
      {name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}

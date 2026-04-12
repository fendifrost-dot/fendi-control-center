import { Link } from "react-router-dom";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { HUB_TOOL_DEFS, type HubToolDef } from "@/lib/hubTools";
import { hubExternalEnvVarName, hubExternalUrls } from "@/lib/hubExternalUrls";
import { cn } from "@/lib/utils";

function toolHref(def: HubToolDef): string | null {
  if (def.kind === "internal") return def.path;
  const u = hubExternalUrls[def.urlKey];
  return u.length > 0 ? u : null;
}

function ToolRow({ def, dimmed }: { def: HubToolDef; dimmed?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-md border border-green-900/50 bg-green-950/20 px-3 py-3 transition-colors",
        !dimmed && "hover:border-green-600/60 hover:bg-green-950/35",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 h-8 w-1 shrink-0 rounded-full", def.accentClass)} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold tracking-wide text-green-300">{def.name}</div>
          <p className="mt-1 text-xs leading-snug text-green-600/90">{def.tagline}</p>
          {dimmed && def.kind === "external" && (
            <p className="mt-2 font-mono text-[10px] text-amber-600/90">
              Set <code className="rounded bg-black/50 px-1 py-0.5 text-green-700/90">{hubExternalEnvVarName[def.urlKey]}</code>{" "}
              in env
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function HubCoverNav() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="border-green-500/50 bg-black/40 text-green-400 shadow-[0_0_12px_rgba(0,255,65,0.25)] hover:bg-green-950/40 hover:text-green-300"
          aria-label="Open tools menu"
        >
          <Menu className="h-6 w-6" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="border-l border-green-900/80 bg-black/95 text-green-100 backdrop-blur-md"
      >
        <SheetHeader>
          <SheetTitle className="font-mono tracking-tight text-green-400">Tools</SheetTitle>
          <SheetDescription className="text-green-700/90">
            Tax prep opens inside this hub. Other products open in a new tab when URLs are configured in the environment.
          </SheetDescription>
        </SheetHeader>
        <nav className="mt-8 flex flex-col gap-2 pr-2">
          {HUB_TOOL_DEFS.map((def) => {
            const href = toolHref(def);
            const dimmed = !href && def.kind === "external";

            if (def.kind === "internal" && href) {
              return (
                <SheetClose asChild key={def.id}>
                  <Link
                    to={href}
                    className="block text-left outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
                  >
                    <ToolRow def={def} />
                  </Link>
                </SheetClose>
              );
            }

            if (def.kind === "external" && href) {
              return (
                <SheetClose asChild key={def.id}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
                  >
                    <ToolRow def={def} />
                  </a>
                </SheetClose>
              );
            }

            return (
              <div key={def.id} className="cursor-not-allowed">
                <ToolRow def={def} dimmed />
              </div>
            );
          })}
        </nav>
        <div className="mt-8 border-t border-green-900/60 pt-4">
          <SheetClose asChild>
            <Link
              to="/ops"
              className="inline-block font-mono text-xs text-green-600/80 underline-offset-4 hover:text-green-400 hover:underline"
            >
              Operator ops →
            </Link>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}

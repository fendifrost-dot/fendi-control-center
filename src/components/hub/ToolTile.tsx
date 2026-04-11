import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ToolTileData } from "./toolRegistry";

const tileClassName =
  "group relative block overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function ToolTile({ tool }: { tool: ToolTileData }) {
  const body = (
    <>
      <div className={cn("h-1.5 w-full shrink-0", tool.accentClass)} aria-hidden />
      {tool.status !== "live" && (
        <div className="absolute right-3 top-3 z-10">
          <Badge variant="secondary" className="capitalize">
            {tool.status}
          </Badge>
        </div>
      )}
      <div className="space-y-1 p-4">
        <h3
          className={cn(
            "text-lg font-semibold tracking-tight",
            tool.status !== "live" && "pr-16",
          )}
        >
          {tool.name}
        </h3>
        <p className="text-sm text-muted-foreground">{tool.tagline}</p>
      </div>
    </>
  );

  if (tool.external) {
    return (
      <a
        href={tool.route}
        target="_blank"
        rel="noreferrer"
        className={tileClassName}
      >
        {body}
      </a>
    );
  }

  return (
    <Link to={tool.route} className={tileClassName}>
      {body}
    </Link>
  );
}

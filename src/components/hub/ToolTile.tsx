import { Link } from "react-router-dom";
import type { ToolTileData } from "./toolRegistry";

const statusBadge: Record<string, { label: string; className: string }> = {
  beta: { label: "Beta", className: "bg-yellow-500/20 text-yellow-300" },
  stranded: { label: "Stranded", className: "bg-red-500/20 text-red-300" },
  planned: { label: "Coming Soon", className: "bg-gray-500/20 text-gray-400" },
};

export function ToolTile({ tool }: { tool: ToolTileData }) {
  const badge = tool.status !== "live" ? statusBadge[tool.status] : null;

  const card = (
    <div className="group relative flex flex-col rounded-lg border border-border bg-card transition-all hover:shadow-lg hover:-translate-y-0.5">
      <div className={`h-1.5 w-full rounded-t-lg ${tool.accentClass}`} />
      <div className="flex flex-1 flex-col gap-1 p-5">
        {badge && (
          <span
            className={`absolute right-3 top-4 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge.className}`}
          >
            {badge.label}
          </span>
        )}
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {tool.name}
        </h3>
        <p className="text-sm text-muted-foreground">{tool.tagline}</p>
      </div>
    </div>
  );

  if (tool.external) {
    return (
      <a href={tool.route} target="_blank" rel="noreferrer" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
        {card}
      </a>
    );
  }

  return (
    <Link to={tool.route} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
      {card}
    </Link>
  );
}

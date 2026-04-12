import { TOOL_REGISTRY } from "@/lib/hubTools";
import { ToolTile } from "./ToolTile";

export function ToolGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {TOOL_REGISTRY.map((tool) => (
        <ToolTile key={tool.id} tool={tool} />
      ))}
    </div>
  );
}

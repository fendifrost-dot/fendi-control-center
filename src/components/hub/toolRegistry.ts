export type ToolStatus = "live" | "beta" | "stranded" | "planned";

export interface ToolTileData {
  id: string;
  name: string;
  tagline: string;
  route: string; // internal route or external URL
  external: boolean; // true if route is an absolute URL
  status: ToolStatus;
  accentClass: string; // tailwind bg color class for the tile accent bar
}

export const TOOL_REGISTRY: ToolTileData[] = [
  {
    id: "tax-generator",
    name: "Tax Generator",
    tagline: "Client returns, IRS forms, TXF export",
    route: "/tax/clients",
    external: false,
    status: "live",
    accentClass: "bg-emerald-500",
  },
  {
    id: "credit-compass",
    name: "Credit Compass",
    tagline: "Credit analysis and dispute letters",
    route: "/credit",
    external: false,
    status: "live",
    accentClass: "bg-sky-500",
  },
  {
    id: "credit-guardian",
    name: "Credit Guardian",
    tagline: "Ongoing credit monitoring (external)",
    route: "https://credit-guardian.placeholder",
    external: true,
    status: "planned",
    accentClass: "bg-indigo-500",
  },
  {
    id: "artist-hub",
    name: "Artist Hub",
    tagline: "Music pitching and playlist outreach",
    route: "/music",
    external: false,
    status: "live",
    accentClass: "bg-fuchsia-500",
  },
  {
    id: "auto-hub",
    name: "Auto Hub",
    tagline: "Vehicle records and maintenance",
    route: "/auto",
    external: false,
    status: "planned",
    accentClass: "bg-amber-500",
  },
  {
    id: "telegram-console",
    name: "Telegram Console",
    tagline: "Bot commands, jobs, sync status",
    route: "/telegram",
    external: false,
    status: "live",
    accentClass: "bg-cyan-500",
  },
];

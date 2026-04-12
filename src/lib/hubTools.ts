import { hubExternalUrls, type HubExternalUrlKey } from "./hubExternalUrls";

export type ToolStatus = "live" | "beta" | "stranded" | "planned";

export type HubToolDef =
  | {
      id: string;
      name: string;
      tagline: string;
      kind: "internal";
      path: string;
      status: ToolStatus;
      accentClass: string;
    }
  | {
      id: string;
      name: string;
      tagline: string;
      kind: "external";
      urlKey: HubExternalUrlKey;
      status: ToolStatus;
      accentClass: string;
    };

/** Single source of truth for cover menu + tool grid tiles. */
export const HUB_TOOL_DEFS: HubToolDef[] = [
  {
    id: "tax-generator",
    name: "Tax Generator",
    tagline: "Client returns, worksheets, and filing prep (in this hub)",
    kind: "internal",
    path: "/clients",
    status: "live",
    accentClass: "bg-emerald-500",
  },
  {
    id: "artist-hub",
    name: "Artist Hub",
    tagline: "Music pitching and artist growth",
    kind: "external",
    urlKey: "artistHub",
    status: "live",
    accentClass: "bg-fuchsia-500",
  },
  {
    id: "credit-compass",
    name: "Credit Compass",
    tagline: "Credit analysis and dispute strategy",
    kind: "external",
    urlKey: "creditCompass",
    status: "live",
    accentClass: "bg-sky-500",
  },
  {
    id: "credit-guardian",
    name: "Credit Guardian",
    tagline: "Ongoing credit monitoring and Guardian workflows",
    kind: "external",
    urlKey: "creditGuardian",
    status: "live",
    accentClass: "bg-indigo-500",
  },
  {
    id: "auto-hub",
    name: "Auto Hub",
    tagline: "Vehicle records and shop workflows",
    kind: "external",
    urlKey: "autoHub",
    status: "live",
    accentClass: "bg-amber-500",
  },
  {
    id: "modest-streetwear",
    name: "Modest Streetwear",
    tagline: "Streetwear brand and retail",
    kind: "external",
    urlKey: "modestStreetwear",
    status: "live",
    accentClass: "bg-violet-500",
  },
];

export interface ToolTileData {
  id: string;
  name: string;
  tagline: string;
  route: string;
  external: boolean;
  status: ToolStatus;
  accentClass: string;
  /** True when external URL is missing from env */
  urlMissing?: boolean;
}

function resolveRoute(def: HubToolDef): { route: string; external: boolean; urlMissing?: boolean } {
  if (def.kind === "internal") {
    return { route: def.path, external: false };
  }
  const url = hubExternalUrls[def.urlKey];
  if (!url) {
    return { route: "", external: true, urlMissing: true };
  }
  return { route: url, external: true };
}

/** Backward-compatible flat list for `ToolGrid` / `ToolTile`. */
export const TOOL_REGISTRY: ToolTileData[] = HUB_TOOL_DEFS.map((def) => {
  const r = resolveRoute(def);
  return {
    id: def.id,
    name: def.name,
    tagline: def.tagline,
    route: r.route,
    external: r.external,
    status: def.status,
    accentClass: def.accentClass,
    urlMissing: r.urlMissing,
  };
});

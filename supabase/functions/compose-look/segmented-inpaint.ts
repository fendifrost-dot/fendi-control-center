// Helpers for lora_segmented_inpaint — SAM-3 masks + FLUX regional fill per garment.

export type GarmentForInpaint = {
  feature_type: string;
  label: string;
  signed_url: string;
  dimensions_description?: string | null;
};

const INPAINT_ELIGIBLE = new Set([
  "wardrobe_outerwear",
  "wardrobe_top",
  "wardrobe_bottom",
  "wardrobe_footwear",
]);

/** Text prompt for SAM-3 to isolate the region we will inpaint for this pick. */
export function segmentPromptForGarment(g: GarmentForInpaint): string {
  const label = (g.label ?? "").trim();
  switch (g.feature_type) {
    case "wardrobe_bottom":
      return label ? `${label} pants trousers jeans` : "pants trousers jeans on lower body";
    case "wardrobe_top":
      return label ? `${label} shirt top on torso` : "shirt top on torso upper body";
    case "wardrobe_outerwear":
      return label ? `${label} jacket coat outerwear` : "jacket coat outerwear on torso";
    case "wardrobe_footwear":
      return label ? `${label} shoes footwear` : "shoes footwear on feet";
    default:
      return label || "clothing garment";
  }
}

export function filterInpaintEligible(
  items: GarmentForInpaint[],
): GarmentForInpaint[] {
  return items.filter((g) => INPAINT_ELIGIBLE.has(g.feature_type) && !!g.signed_url);
}

/** Per-region FLUX-fill prompt — garment ref is passed via fill_image separately. */
export function buildRegionInpaintPrompt(g: GarmentForInpaint): string {
  const parts = [
    `In the masked region only, dress the subject in the exact garment: ${g.label}.`,
    "Match the reference product photo for color, fabric, closure, and silhouette.",
  ];
  if (g.feature_type === "wardrobe_outerwear") {
    parts.push(
      "The jacket is FULLY ZIPPED and FULLY CLOSED — no exposed chest, no open front, no bare skin under the jacket. The bomber covers the entire torso from collar to hem. The chest and stomach area are completely covered by the jacket fabric, not visible. Zipper is fully pulled up to the neck.",
    );
  }
  const dims = (g.dimensions_description ?? "").trim();
  if (dims) parts.push(dims);
  parts.push(
    "Do not alter face, hair, skin, eyewear, hands, or any unmasked pixels.",
    "Photorealistic fit and folds. No invented logos, text, or graphics on fabric.",
  );
  return parts.join(" ");
}

export function stageSlug(label: string, featureType: string): string {
  const safe = label.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24).toLowerCase() ||
    featureType.replace("wardrobe_", "");
  return safe;
}

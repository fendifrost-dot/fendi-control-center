/** In-app path to return to after sign-in. Rejects protocol-relative and off-site targets. */
export function safeReturnPath(from: string | undefined | null): string | null {
  if (!from) return null;
  if (!from.startsWith("/") || from.startsWith("//") || from.startsWith("/\\")) return null;
  if (from.includes("\\") || from.includes("://")) return null;
  const pathOnly = from.split("?")[0]?.split("#")[0] ?? "";
  if (pathOnly === "/login" || pathOnly === "/forgot-password" || pathOnly === "/reset-password") return null;
  return from;
}

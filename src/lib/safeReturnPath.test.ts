import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./safeReturnPath";

describe("safeReturnPath", () => {
  it("keeps the MCP consent return, including the query string", () => {
    expect(safeReturnPath("/oauth/mcp-authorize?client_id=abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect"))
      .toBe("/oauth/mcp-authorize?client_id=abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect");
  });

  it("rejects off-site targets", () => {
    expect(safeReturnPath("//chatgpt.com")).toBeNull();
    expect(safeReturnPath("/\\chatgpt.com")).toBeNull();
    expect(safeReturnPath("https://chatgpt.com/connector_platform_oauth_redirect")).toBeNull();
    expect(safeReturnPath("/login")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });
});

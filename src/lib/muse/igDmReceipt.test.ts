import { describe, expect, it } from "vitest";
import { igDmReceiptHubStatus } from "./igDmReceipt";

const NOTICE = `IG_DM_RECEIPT_REFUSED
hub_status: 403
handoff_record_id: 6f14b53d-4c16-49ec-a475-a1bf94229499
reference: ig-dm-thread-8841
code: muse_ig_receipt_scope
error: muse_ig_receipt may only call mark_manual_ig_dm_submitted`;

describe("ig dm receipt board notices", () => {
  it("reads a 403 or 409 from a refusal notice", () => {
    expect(igDmReceiptHubStatus(NOTICE)).toBe(403);
    expect(igDmReceiptHubStatus(NOTICE.replace("hub_status: 403", "hub_status: 409"))).toBe(409);
  });

  it("ignores other mentions of those statuses", () => {
    expect(igDmReceiptHubStatus("Retry returned 403 from somewhere else")).toBeNull();
    expect(igDmReceiptHubStatus("IG_DM_RECEIPT_REFUSED\nhub_status: 422")).toBeNull();
    expect(igDmReceiptHubStatus("hub_status: 403")).toBeNull();
    expect(igDmReceiptHubStatus(null)).toBeNull();
  });
});

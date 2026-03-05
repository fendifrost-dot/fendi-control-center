import type {
  TradelineObject,
  PersonalInfoFlag,
  InquiryFlag,
  NegativeAccountFlag,
} from "@/types/assessment";
import type { ClientProfile } from "@/components/ClientProfileInput";

// v3 — complete keyword list including all bureau variants
const NEGATIVE_KEYWORDS = [
  "past due",
  "past-due",
  "past due amount",
  "derogatory",
  "charge off",
  "charged off",
  "charged-off",
  "c/o",
  "written off",
  "write off",
  "collection",
  "collections",
  "placed for collection",
  "payment after charge-off",
  "worst payment status",
  "needs attention",
  "potentially negative",
  "late payment",
  "late payments",
  "30 days late",
  "60 days late",
  "90 days late",
  "120 days late",
  "150 days late",
  "180 days late",
  "30-day",
  "60-day",
  "90-day",
  "120-day",
];

// v3 — scan only allowed zones, not legends or glossaries
// allowedScanZoneText is pre-extracted by the parser from:
// status lines, remarks lines, past due lines,
// payment status summaries, and actual payment history rows only.
// It explicitly excludes payment legend/key sections.
export function isNegativeTradeline(tradeline: TradelineObject): boolean {
  // Vision model already flagged this
  if (tradeline.paymentFlag === "NEGATIVE") return true;

  // Only scan the allowed zone text — not the full raw block
  // This prevents legend text like "CO = Charge Off" from
  // falsely flagging a clean account
  const scanText = tradeline.allowedScanZoneText.toLowerCase();
  return NEGATIVE_KEYWORDS.some((kw) => scanText.includes(kw));
}

export function buildPersonalInfoFlags(
  bureauNames: string[],
  bureauAddresses: string[],
  bureauEmployers: string[],
  client: ClientProfile
): PersonalInfoFlag[] {
  const flags: PersonalInfoFlag[] = [];

  bureauNames.forEach((n) => {
    if (n.trim().toUpperCase() !== client.fullLegalName.toUpperCase()) {
      flags.push({
        type: "NAME",
        bureauValue: n,
        clientValue: client.fullLegalName,
        flag: "REMOVE",
      });
    }
  });

  bureauAddresses.forEach((a) => {
    if (a.trim().toUpperCase() !== client.currentAddress.toUpperCase()) {
      flags.push({
        type: "ADDRESS",
        bureauValue: a,
        clientValue: client.currentAddress,
        flag: "REMOVE",
      });
    }
  });

  bureauEmployers.forEach((e) => {
    const clientEmp = client.employer.toUpperCase();
    if (clientEmp === "NONE" || e.trim().toUpperCase() !== clientEmp) {
      flags.push({
        type: "EMPLOYER",
        bureauValue: e,
        clientValue: client.employer,
        flag: "REMOVE",
      });
    }
  });

  return flags;
}

// v3 — only flag HARD inquiries, pass through inquiry type
export function buildInquiryFlags(
  inquiries: {
    creditor: string;
    date: string;
    businessType?: string;
    inquiryType: "HARD" | "SOFT" | "UNKNOWN";
  }[]
): InquiryFlag[] {
  return inquiries
    .filter((inq) => inq.inquiryType !== "SOFT")
    .map((inq) => ({
      creditor: inq.creditor,
      date: inq.date,
      businessType: inq.businessType,
      inquiryType: inq.inquiryType,
      flag: "FLAG FOR REMOVAL" as const,
    }));
}

export function buildNegativeAccountFlags(
  tradelines: TradelineObject[]
): NegativeAccountFlag[] {
  return tradelines
    .filter((t) => isNegativeTradeline(t))
    .map((t) => ({
      accountName: t.accountName,
      // v3 — preserve exactly as printed: masked, partial, Not Displayed, or null
      accountNumber: t.accountNumber,
      dateOpened: t.dateOpened,
      amount: t.balance,
      statusText: t.statusText,
      remarks: t.remarks,
      openOrClosed: t.openClosed,
      isCollection: t.isCollection,
      collectionAgency: t.collectionAgency,
      originalCreditor: t.originalCreditor,
      bureauSource: t.bureauSource,
      flag: "NEGATIVE ACCOUNT — FLAGGED" as const,
    }));
}

export function runValidationGate(
  extracted: {
    negativeCount: number;
    collectionCount: number;
  },
  bureau: {
    accountsEverLate: number;
    collectionsCount: number;
  }
): { passed: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (bureau.collectionsCount > 0 &&
      extracted.collectionCount < bureau.collectionsCount) {
    warnings.push(
      `ERROR: EXTRACTION INCOMPLETE — COLLECTIONS UNDERCOUNTED. ` +
      `Bureau reports ${bureau.collectionsCount}, extracted ${extracted.collectionCount}.`
    );
  }

  if (bureau.accountsEverLate > 0 &&
      extracted.negativeCount + extracted.collectionCount <
      bureau.accountsEverLate) {
    warnings.push(
      `WARNING: Negative item count ` +
      `(${extracted.negativeCount} accounts + ${extracted.collectionCount} collections) ` +
      `is less than bureau reported accounts ever late (${bureau.accountsEverLate}). ` +
      `Manual review recommended.`
    );
  }

  return {
    passed: warnings.filter((w) => w.startsWith("ERROR")).length === 0,
    warnings,
  };
}

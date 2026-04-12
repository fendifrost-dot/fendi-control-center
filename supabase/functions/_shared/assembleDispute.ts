/**
 * Modular dispute letter assembly from client state, triggers, and retrieved knowledge only.
 * Does not invent legal theories beyond fixed procedural demands (FCRA MOV) and supplied snippets.
 */

import { strategyForLevel, type EscalationResult } from "./disputeEscalation.ts";
import type { RetrievedKnowledge } from "./retrieveRelevantKnowledge.ts";
import { type TriggerEvidenceContext, selectPrimaryTrigger } from "./selectPrimaryTrigger.ts";
import {
  type StrategyWarningCode,
  validateDisputeStrategy,
} from "./validateDisputeStrategy.ts";

export interface DisputeAssemblyClientState {
  consumerName: string;
  bureau: string;
  accountName?: string;
  /** Optional one-line account / tradeline identifiers from source data (not invented). */
  accountDetailLine?: string;
}

export interface AssembleDisputeInput {
  clientState: DisputeAssemblyClientState;
  triggers: string[];
  retrievedKnowledge: RetrievedKnowledge;
  /** If omitted, computed via `selectPrimaryTrigger(triggers)`. */
  primaryTrigger?: string | null;
  /** If omitted, computed via `selectPrimaryTrigger(triggers)` (max 2). */
  secondaryTriggers?: string[];
  /** Escalation from `determineEscalationLevel`; defaults to level 1 if omitted. */
  escalation?: EscalationResult;
  /** From `selectPrimaryTrigger` / case state (audit trail). */
  triggerReasoning?: string;
  triggerConfidence?: number;
  /** Multi-source evidence for confidence (matches `extractCaseStateFromDetailDocs`). */
  triggerEvidence?: TriggerEvidenceContext;
}

export interface AssembleDisputeResult {
  /** Full letter body (plain text, letter sections). */
  letterBody: string;
  subject: string;
  bureau: string;
  /** Citations referenced in the letter (system + any visible in retrieved snippets). */
  legalCitations: string[];
  /** Assembly was limited because no retrieval content was available for arguments. */
  retrievalSparse: boolean;
  escalation: EscalationResult;
  /** Focus trigger for retrieval + letter core (see `selectPrimaryTrigger`). */
  primaryTrigger: string | null;
  secondaryTriggers: string[];
  triggerReasoning: string;
  triggerConfidence: number;
  /** Cross-layer checks from `validateDisputeStrategy`. */
  strategyWarnings: string[];
  /** Machine-readable codes; drive tone and structure in assembly. */
  warningCodes: StrategyWarningCode[];
}

const IDENTITY_TRIGGER = "identity_theft_account_present";

function normalizeLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function dedupeParagraphs(paragraphs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paragraphs) {
    const n = normalizeLine(p);
    if (n.length < 12) continue;
    const key = n.slice(0, 160).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Identity-theft opening only when the *primary* focus is identity theft (avoids mixed theories). */
function hasIdentityPrimary(primaryTrigger: string | null | undefined): boolean {
  return primaryTrigger === IDENTITY_TRIGGER;
}

/** Softer letter tone when trigger confidence is low (drops pre-litigation voice). */
function toneEscalationForWarnings(
  escalation: EscalationResult,
  codes: StrategyWarningCode[],
): EscalationResult {
  if (codes.includes("low_confidence") && escalation.level >= 4) {
    const nl = 3 as const;
    return { level: nl, strategy: strategyForLevel(nl) };
  }
  return escalation;
}

function tonePrefix(level: number): string {
  switch (level) {
    case 4:
      return "This correspondence is written in anticipation of regulatory and judicial review. ";
    case 3:
      return "Non-compliance with prior reinvestigation obligations is not acceptable. ";
    case 2:
      return "This is a follow-up dispute following prior correspondence. ";
    default:
      return "";
  }
}

function openingSection(
  client: DisputeAssemblyClientState,
  primaryTrigger: string | null,
  escalation: EscalationResult,
): string {
  const bureau = normalizeLine(client.bureau || "the credit reporting agency");
  const name = normalizeLine(client.consumerName || "Consumer");
  const pre = tonePrefix(escalation.level);

  if (hasIdentityPrimary(primaryTrigger)) {
    const body =
      escalation.level <= 1
        ? `I, ${name}, submit this written dispute under the Fair Credit Reporting Act (FCRA). I am disputing the accuracy and permissible reporting of information on my consumer file, including in connection with identity theft and/or mixed-file concerns where applicable. The following items are disputed with specificity and require reinvestigation and, where appropriate, deletion.`
        : escalation.level === 2
        ? `I, ${name}, reiterate this dispute under the FCRA, including identity-theft-related reporting concerns. Prior correspondence has not resolved the issues below; reinvestigation and corrective action remain required.`
        : escalation.level === 3
        ? `I, ${name}, demand immediate reinvestigation and correction of identity-theft-related inaccuracies. Your prior responses have not satisfied statutory duties; the deficiencies identified below require remediation without further delay.`
        : `I, ${name}, place you on notice that identity-theft-related inaccuracies remain disputed. Failure to correct and document verification may result in referral to regulators and counsel.`;

    const expanded =
      escalation.level >= 2
        ? " This dispute implicates identity-theft blocking and suppression duties under the FCRA where applicable."
        : "";
    return [`Dear ${bureau} Disputes:`, "", pre + body + expanded, ""].join("\n");
  }

  const body =
    escalation.level <= 1
      ? `I, ${name}, submit this formal dispute under the Fair Credit Reporting Act. The following tradeline and reporting issues are disputed. This letter is a request for reinvestigation and for you to apply the statutory standards for maximum possible accuracy and permissible purpose.`
      : escalation.level === 2
      ? `I, ${name}, submit this follow-up dispute under the FCRA. Prior disputes have not produced the corrections requested; the items below remain inaccurate or unverified as required.`
      : escalation.level === 3
      ? `I, ${name}, demand compliance with the FCRA. Your handling of prior disputes has not met reinvestigation and accuracy obligations; the deficiencies below must be cured without further delay.`
      : `I, ${name}, place you on formal notice of continued FCRA non-compliance. Unless the following are corrected and documented, this matter will be escalated to the CFPB, state authorities, and litigation counsel as appropriate.`;

  return [`Dear ${bureau} Disputes:`, "", pre + body, ""].join("\n");
}

/** Map trigger ids to keywords used to pair dispute-example lines (deterministic). */
const TRIGGER_KEYWORDS: Record<string, RegExp> = {
  reinserted_account: /\bre-?insert|reappear|deleted.*report|removed.*report/i,
  unauthorized_inquiry: /\binquir|hard\s+pull|permissible\s+purpose/i,
  late_payment: /\blate\b|delinq|past\s+due|30|60|90|120/i,
  identity_theft_account_present: /\bidentity|fraud|ftc|affidavit/i,
  duplicate_collection: /\bduplicate|double|same\s+creditor|multiple\s+account/i,
  inconsistent_status: /\bopen|closed|paid|balance|status/i,
  missing_credit_report: /\breport|file|access|unavailable/i,
};

function pickExamplesForTriggers(
  examples: string[],
  /** Primary first, then secondary — limits mixed arguments. */
  triggers: string[],
): { heading: string; text: string }[] {
  const used = new Set<number>();
  const out: { heading: string; text: string }[] = [];

  for (const trig of triggers) {
    const kw = TRIGGER_KEYWORDS[trig];
    let idx = -1;
    if (kw) {
      idx = examples.findIndex((ex, i) => !used.has(i) && kw.test(ex));
    }
    if (idx < 0) {
      idx = examples.findIndex((_, i) => !used.has(i));
    }
    if (idx < 0) continue;
    used.add(idx);
    out.push({ heading: trig.replace(/_/g, " "), text: normalizeLine(examples[idx]) });
  }

  for (let i = 0; i < examples.length; i++) {
    if (used.has(i)) continue;
    out.push({ heading: "Supporting pattern", text: normalizeLine(examples[i]) });
  }

  return out;
}

/** Strongest legal leverage first: reinsertion > identity > MOV/procedural > accuracy > payment. */
function violationStrengthScore(text: string): number {
  const s = text.toLowerCase();
  if (/re-?insert|reappear|deleted.*report|reinsertion/i.test(s)) return 100;
  if (/identity|theft|605b|fraud|blocking/i.test(s)) return 90;
  if (/611\(a\)\(7\)|method of verification|mov\b|verification/i.test(s)) return 78;
  if (/604|permissible|inquir/i.test(s)) return 72;
  if (/maximum possible accuracy|incomplete|inaccurate|623/i.test(s)) return 58;
  if (/late|delinq|past due|30|60|90/i.test(s)) return 42;
  return 25;
}

function sortViolationLinesByStrength(lines: string[]): string[] {
  return [...lines].sort((a, b) => violationStrengthScore(b) - violationStrengthScore(a));
}

function violationSection(retrieved: RetrievedKnowledge, primaryTrigger: string | null): string {
  const primary = retrieved.violationLogic.length
    ? retrieved.violationLogic
    : retrieved.analysisPatterns;
  const maxItems = primaryTrigger === "reinserted_account" ? 4 : 3;
  const deduped = dedupeParagraphs(primary);
  const sorted = sortViolationLinesByStrength(deduped);
  const take = sorted.slice(0, maxItems);
  if (!take.length) {
    return "";
  }
  const lines = take.map((t, i) => `${i + 1}. ${t}`);
  const title =
    primaryTrigger === "reinserted_account"
      ? "Reinsertion / verification issues (prior-case patterns; expanded focus):"
      : "Alleged reporting / reinvestigation issues (from prior-case patterns supplied for consistency):";
  return [title, "", ...lines, ""].join("\n");
}

function accountArgumentsSection(
  retrieved: RetrievedKnowledge,
  /** Ordered: primary, then up to two secondary — core argument focus. */
  focusTriggers: string[],
): string {
  const examples = dedupeParagraphs(retrieved.disputeExamples);
  if (!examples.length) return "";

  const paired = pickExamplesForTriggers(examples, focusTriggers.length ? focusTriggers : ["general"]);
  const blocks = paired.map(
    (p) => `Regarding (${p.heading}):\n${p.text}`,
  );
  return ["Account- and trigger-specific arguments (primary focus first; supplied patterns only):", "", ...blocks, ""].join("\n\n");
}

function coreFocusLine(primaryTrigger: string | null): string {
  if (!primaryTrigger) return "";
  return `Core dispute focus: ${primaryTrigger.replace(/_/g, " ")}.\n\n`;
}

function accountIdentification(client: DisputeAssemblyClientState): string {
  const parts: string[] = [];
  if (client.accountName) parts.push(`Account / tradeline as reported: ${normalizeLine(client.accountName)}.`);
  if (client.accountDetailLine) parts.push(normalizeLine(client.accountDetailLine));
  if (!parts.length) return "";
  return ["Report identification:", ...parts, ""].join("\n");
}

function demandSection(escalation: EscalationResult, primaryTrigger: string | null): string {
  const lines: string[] = [];

  if (escalation.level >= 3) {
    lines.push(
      "Given prior non-compliance and unresolved disputes, the following demands are reiterated with heightened scrutiny.",
      "",
    );
  }

  lines.push(
    "Demands (procedural):",
    "",
    "1. Delete or modify the disputed item(s) if, after reinvestigation, they cannot be verified as accurate, complete, or reported consistent with maximum possible accuracy and permissible purpose.",
    "",
    "2. Provide the method of verification as required by Fair Credit Reporting Act § 611(a)(7), 15 U.S.C. § 1681i(a)(7), including the business name and address of any furnisher contacted and a summary of any response obtained.",
    "",
  );

  if (primaryTrigger === IDENTITY_TRIGGER) {
    lines.push(
      "Additional (identity theft): Confirm block and suppression obligations consistent with 15 U.S.C. § 1681c-5 (FCRA § 605B) where the tradeline arises from identity theft, and document what steps were taken.",
      "",
    );
  }

  lines.push(
    "3. Complete reinvestigation within the statutory timeframe and provide written results of reinvestigation, including notice of any deletion or modification.",
    "",
    "4. Cease reinsertion of any deleted item unless the notice requirements of the FCRA are satisfied.",
    "",
  );

  if (escalation.level >= 3) {
    lines.push(
      "5. Preserve all records relating to this tradeline, prior disputes, and furnishers contacted in connection with reinvestigation.",
      "",
    );
  }
  if (escalation.level >= 4) {
    lines.push(
      "6. Treat this letter as preservation notice for litigation and regulatory complaints; failure to cure may result in filing without further warning.",
      "",
    );
  }

  return lines.join("\n");
}

function closingSection(client: DisputeAssemblyClientState, escalation: EscalationResult): string {
  const name = normalizeLine(client.consumerName || "Consumer");
  const closer =
    escalation.level >= 4
      ? "Sincerely (without waiver of rights),"
      : escalation.level >= 3
      ? "Sincerely,"
      : "Respectfully,";
  return [closer, "", name, ""].join("\n");
}

function extractCitationsFromText(texts: string[]): string[] {
  const cites = new Set<string>();
  const re = /(?:15\s*U\.S\.C\.|U\.S\.C\.|§+\s*\d+)/gi;
  for (const t of texts) {
    const m = t.match(re);
    if (m) m.forEach((x) => cites.add(normalizeLine(x)));
  }
  return [...cites].slice(0, 8);
}

/** Build assembly client state from Credit Guardian detail + dispute item (no fabrication). */
export function buildDisputeAssemblyClientState(
  detail: Record<string, unknown>,
  disputeItem: Record<string, unknown>,
): DisputeAssemblyClientState {
  const client = detail.client && typeof detail.client === "object"
    ? (detail.client as Record<string, unknown>)
    : {};
  const name = String(client.legal_name ?? client.preferred_name ?? "Consumer");
  const bureau = String(disputeItem.bureau ?? "Credit Bureau");
  const accountName = String(disputeItem.account_name ?? disputeItem.account ?? "").trim();
  const idLine = [disputeItem.account_number, disputeItem.reference]
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => String(x).trim())
    .join("; ");
  return {
    consumerName: name,
    bureau,
    accountName: accountName || undefined,
    accountDetailLine: idLine ? `Reference / identifiers as available: ${idLine}.` : undefined,
  };
}

/**
 * Assembles a dispute letter from structured inputs and retrieved knowledge buckets only.
 * Does not call an LLM. Omits fact-specific legal theories when retrieval is empty.
 */
function subjectForEscalation(escalation: EscalationResult, bureau: string, accountBit: string): string {
  const b = `${bureau}${accountBit}`;
  switch (escalation.level) {
    case 4:
      return `Pre-litigation FCRA notice — ${b}`;
    case 3:
      return `Formal demand — FCRA non-compliance — ${b}`;
    case 2:
      return `Follow-up FCRA dispute — ${b}`;
    default:
      return `Formal FCRA dispute — ${b}`;
  }
}

export function assembleDispute(input: AssembleDisputeInput): AssembleDisputeResult {
  const { clientState, triggers, retrievedKnowledge } = input;
  const sel = selectPrimaryTrigger(triggers, input.triggerEvidence);
  const primaryTrigger = input.primaryTrigger ?? sel.primaryTrigger;
  let secondaryTriggers = input.secondaryTriggers ?? sel.secondaryTriggers;
  const triggerReasoning = input.triggerReasoning ?? sel.triggerReasoning;
  const triggerConfidence = input.triggerConfidence ?? sel.triggerConfidence;

  const escalation = input.escalation ?? { level: 1 as const, strategy: "initial" as const };

  const strategy = validateDisputeStrategy({
    primaryTrigger,
    escalationLevel: escalation.level,
    secondaryTriggers,
    triggerConfidence,
    triggerEvidence: input.triggerEvidence,
  });

  if (strategy.warningCodes.includes("trigger_conflict")) {
    secondaryTriggers = [];
  }

  const focusOrder = [primaryTrigger, ...secondaryTriggers].filter((x): x is string => Boolean(x));

  const toneEscalation = toneEscalationForWarnings(escalation, strategy.warningCodes);

  const bureau = normalizeLine(clientState.bureau || "Credit Bureau");
  const accountBit = clientState.accountName ? ` — ${normalizeLine(clientState.accountName)}` : "";
  const subject = subjectForEscalation(toneEscalation, bureau, accountBit);

  const sections: string[] = [];
  sections.push(openingSection(clientState, primaryTrigger, toneEscalation));

  const focus = coreFocusLine(primaryTrigger);
  if (focus) sections.push(focus);

  const idBlock = accountIdentification(clientState);
  if (idBlock) sections.push(idBlock);

  if (strategy.warningCodes.includes("weak_evidence")) {
    sections.push(
      "This dispute is based on currently available information and subject to further verification.\n\n",
    );
  }

  const viol = violationSection(retrievedKnowledge, primaryTrigger);
  if (viol) sections.push(viol);

  const acct = accountArgumentsSection(retrievedKnowledge, focusOrder);
  if (acct) sections.push(acct);

  const hasViolationContent =
    retrievedKnowledge.violationLogic.length > 0 || retrievedKnowledge.analysisPatterns.length > 0;
  const hasExamples = retrievedKnowledge.disputeExamples.length > 0;
  const retrievalSparse = !hasViolationContent && !hasExamples;

  if (retrievalSparse) {
    sections.push(
      [
        "Note: No supplemental pattern excerpts were attached for this tradeline in the knowledge retrieval set.",
        "The procedural demands below remain in full force and effect.",
        "",
      ].join("\n"),
    );
  }

  sections.push(demandSection(toneEscalation, primaryTrigger));
  sections.push(closingSection(clientState, toneEscalation));

  const letterBody = `${sections.filter(Boolean).join("\n")}\n`;

  const baseCites = [
    "Fair Credit Reporting Act § 611(a)(7) (method of verification)",
    "15 U.S.C. § 1681i(a)(7)",
  ];
  if (primaryTrigger === IDENTITY_TRIGGER) {
    baseCites.push("15 U.S.C. § 1681c-5 (FCRA § 605B identity theft blocking)");
  }
  const fromKnowledge = extractCitationsFromText([
    ...retrievedKnowledge.violationLogic,
    ...retrievedKnowledge.disputeExamples,
  ]);

  return {
    letterBody,
    subject,
    bureau,
    legalCitations: [...baseCites, ...fromKnowledge],
    retrievalSparse,
    escalation,
    primaryTrigger,
    secondaryTriggers,
    triggerReasoning,
    triggerConfidence,
    strategyWarnings: strategy.warnings,
    warningCodes: strategy.warningCodes,
  };
}

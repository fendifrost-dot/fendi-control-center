/**
 * Pure routing predicates for explicit Credit Guardian ingest (Telegram webhook).
 * Used by integration tests — keep in sync with telegram-webhook auto-promote guards.
 */
import { isExplicitCreditGuardianIngestIntent } from "./creditDecisionEngine.ts";
import type { CreditGuardianFinalOutcome } from "./explicitCgIngestOutcome.ts";

export interface ExplicitCgTelegramRoutingSnapshot {
  explicitCreditGuardianIngestIntent: boolean;
  autoPromoteDriveIngest: boolean;
  /** NL block uses `&& !explicitCgIngestIntent` */
  skipsNlClassification: boolean;
  /** Autonomous uses `!explicitCgIngestIntent && ...` */
  skipsAutonomousForExplicit: boolean;
  /** If true, webhook returns before Lane 2 (implemented: Lane 1 ingest; unimplemented: blocked message). */
  exitsBeforeLane2Assistant: boolean;
  selectedWorkflow: "drive_ingest" | null;
  useExplicitCreditGuardianIngestFlag: boolean;
  /** Set when explicit intent but drive_ingest not in implemented keys */
  precheckFinalOutcome: CreditGuardianFinalOutcome | null;
}

export function getExplicitCreditGuardianTelegramRouting(
  text: string,
  driveIngestImplemented: boolean,
): ExplicitCgTelegramRoutingSnapshot {
  const lowerText = text.trim().toLowerCase();
  const explicitCreditGuardianIngestIntent = isExplicitCreditGuardianIngestIntent(lowerText);
  const autoPromoteDriveIngest = explicitCreditGuardianIngestIntent && driveIngestImplemented;
  const precheckFinalOutcome: CreditGuardianFinalOutcome | null =
    explicitCreditGuardianIngestIntent && !driveIngestImplemented ? "blocked_unimplemented" : null;

  return {
    explicitCreditGuardianIngestIntent,
    autoPromoteDriveIngest,
    skipsNlClassification: explicitCreditGuardianIngestIntent,
    skipsAutonomousForExplicit: explicitCreditGuardianIngestIntent,
    exitsBeforeLane2Assistant: explicitCreditGuardianIngestIntent,
    selectedWorkflow: autoPromoteDriveIngest ? "drive_ingest" : null,
    useExplicitCreditGuardianIngestFlag: autoPromoteDriveIngest,
    precheckFinalOutcome,
  };
}

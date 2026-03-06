import { useState } from "react";
import type { CreditAssessment } from "@/types/assessment";
import type { ClientProfile } from "@/components/ClientProfileInput";
import {
  buildPersonalInfoFlags,
  buildInquiryFlags,
  buildNegativeAccountFlags,
  runValidationGate,
  isNegativeTradeline,
} from "@/lib/assessment-engine";
import type { TradelineObject } from "@/types/assessment";

export function useAssessment() {
  const [assessment, setAssessment] = useState<CreditAssessment | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  function runAssessment(
    clientProfile: ClientProfile,
    parsedData: {
      bureau: string;
      reportDate: string;
      consumerName: string;
      accountsEverLate: number;
      collectionsCount: number;
      publicRecordsCount: number;
      hardInquiriesCount: number;
      bureauNames: string[];
      bureauAddresses: string[];
      bureauEmployers: string[];
      inquiries: {
        creditor: string;
        date: string;
        businessType?: string;
        inquiryType: "HARD" | "SOFT" | "UNKNOWN";
      }[];
      tradelines: TradelineObject[];
    }
  ) {
    setIsRunning(true);

    const personalInfoFlags = buildPersonalInfoFlags(
      parsedData.bureauNames,
      parsedData.bureauAddresses,
      parsedData.bureauEmployers,
      clientProfile
    );

    const inquiryFlags = buildInquiryFlags(parsedData.inquiries);

    const negativeTradelines = parsedData.tradelines.filter(isNegativeTradeline);
    const collections = negativeTradelines.filter((t) => t.isCollection);
    const negativeAccountFlags = buildNegativeAccountFlags(parsedData.tradelines);

    const validation = runValidationGate(
      {
        negativeCount: negativeTradelines.length,
        collectionCount: collections.length,
      },
      {
        accountsEverLate: parsedData.accountsEverLate,
        collectionsCount: parsedData.collectionsCount,
      }
    );

    const result: CreditAssessment = {
      reportMetadata: {
        bureau: parsedData.bureau as any,
        reportDate: parsedData.reportDate,
        consumerName: parsedData.consumerName,
        accountsEverLate: parsedData.accountsEverLate,
        collectionsCount: parsedData.collectionsCount,
        publicRecordsCount: parsedData.publicRecordsCount,
        hardInquiriesCount: parsedData.hardInquiriesCount,
      },
      clientProfile,
      tradelineInventory: {
        totalDetected: parsedData.tradelines.length,
        negativeCount: negativeTradelines.length,
        collectionCount: collections.length,
        reconciled: validation.passed,
      },
      personalInfoFlags,
      inquiryFlags,
      negativeAccountFlags,
      assessmentSummary: {
        personalInfoFlagged: personalInfoFlags.length,
        inquiriesFlagged: inquiryFlags.length,
        negativeAccountsFlagged: negativeAccountFlags.filter(
          (f) => !f.isCollection
        ).length,
        collectionsFlagged: collections.length,
        totalFlagged:
          personalInfoFlags.length +
          inquiryFlags.length +
          negativeAccountFlags.length,
      },
      validationWarnings: validation.warnings,
    };

    setAssessment(result);
    setIsRunning(false);
  }

  function resetAssessment() {
    setAssessment(null);
  }

  return { assessment, isRunning, runAssessment, resetAssessment };
}

export type BureauSource =
  | 'EXPERIAN'
  | 'EQUIFAX'
  | 'TRANSUNION'
  | 'CREDIT_KARMA'
  | 'ANNUAL_CREDIT_REPORT'
  | 'UNKNOWN';

export type PersonalInfoFlag = {
  type: 'NAME' | 'ADDRESS' | 'EMPLOYER';
  bureauValue: string;
  clientValue: string;
  flag: 'REMOVE';
};

export type InquiryFlag = {
  creditor: string;
  date: string;
  businessType?: string;
  inquiryType: 'HARD' | 'SOFT' | 'UNKNOWN';
  flag: 'FLAG FOR REMOVAL';
};

export type NegativeAccountFlag = {
  accountName: string;
  accountNumber: string | 'Not Displayed' | null;
  dateOpened: string;
  amount: string;
  statusText: string;
  remarks: string;
  openOrClosed: 'Open' | 'Closed' | 'Unknown';
  isCollection: boolean;
  collectionAgency?: string;
  originalCreditor?: string;
  bureauSource: BureauSource;
  flag: 'NEGATIVE ACCOUNT — FLAGGED';
};

export type PaymentGridResult = {
  accountName: string;
  accountNumber?: string | null;
  paymentFlag: 'NEGATIVE' | 'CLEAN' | 'UNREADABLE';
  negativeCells: string[];
  lateCount: number;
  worstStatus: '30' | '60' | '90' | '120' | '150' | '180' | 'CO' | 'C' | 'NONE';
};

export type TradelineObject = {
  accountName: string;
  accountNumber: string | 'Not Displayed' | null;
  dateOpened: string;
  balance: string;
  statusText: string;
  remarks: string;
  openClosed: 'Open' | 'Closed' | 'Unknown';
  paymentFlag: 'NEGATIVE' | 'CLEAN' | 'UNREADABLE';
  negativeCells: string[];
  lateCount: number;
  worstStatus: string;
  fullTextBlock: string;
  allowedScanZoneText: string;
  isNegative: boolean;
  isCollection: boolean;
  collectionAgency?: string;
  originalCreditor?: string;
  bureauSource: BureauSource;
};

export type AssessmentSummary = {
  personalInfoFlagged: number;
  inquiriesFlagged: number;
  negativeAccountsFlagged: number;
  collectionsFlagged: number;
  totalFlagged: number;
};

export type CreditAssessment = {
  reportMetadata: {
    bureau: BureauSource;
    reportDate: string;
    consumerName: string;
    accountsEverLate: number;
    collectionsCount: number;
    publicRecordsCount: number;
    hardInquiriesCount: number;
  };
  clientProfile: {
    fullLegalName: string;
    currentAddress: string;
    employer: string;
  };
  tradelineInventory: {
    totalDetected: number;
    negativeCount: number;
    collectionCount: number;
    reconciled: boolean;
  };
  personalInfoFlags: PersonalInfoFlag[];
  inquiryFlags: InquiryFlag[];
  negativeAccountFlags: NegativeAccountFlag[];
  assessmentSummary: AssessmentSummary;
  validationWarnings: string[];
};

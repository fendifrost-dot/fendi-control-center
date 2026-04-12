/**
 * Deterministic credit trigger detection (no AI).
 * Only emits triggers when explicit structured fields or unambiguous snapshot/account logic applies.
 */

export type CreditCaseState = Record<string, unknown> | null | undefined;
/** Parsed credit report findings: array of objects/strings, a single object, or null. */
export type CreditObservations = unknown;

const KNOWN_TRIGGERS = [
  "reinserted_account",
  "unauthorized_inquiry",
  "late_payment",
  "identity_theft_account_present",
  "duplicate_collection",
  "inconsistent_status",
  "missing_credit_report",
] as const;

export type KnownCreditTrigger = (typeof KNOWN_TRIGGERS)[number];

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function asArray(x: unknown): unknown[] {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x;
  return [x];
}

function truthyFlag(x: unknown): boolean {
  if (x === true) return true;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  return false;
}

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normCreditor(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function balancesSimilar(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const hi = Math.max(a, b);
  return Math.abs(a - b) / hi <= 0.02;
}

function accountId(acc: Record<string, unknown>): string | null {
  const id =
    acc.account_id ?? acc.tradeline_id ?? acc.id ?? acc.account_number ?? acc.external_id;
  if (id === null || id === undefined) return null;
  return String(id);
}

function accountMarkedDeleted(acc: Record<string, unknown>): boolean {
  if (truthyFlag(acc.previously_deleted)) return true;
  if (truthyFlag(acc.removed_from_report)) return true;
  if (truthyFlag(acc.deleted)) return true;
  const st = acc.status ?? acc.account_status;
  if (typeof st === "string" && /^(deleted|removed)$/i.test(st.trim())) return true;
  return false;
}

function accountActiveOnReport(acc: Record<string, unknown>): boolean {
  if (truthyFlag(acc.removed_from_report)) return false;
  if (truthyFlag(acc.deleted)) return false;
  const st = acc.status ?? acc.account_status;
  if (typeof st === "string" && /^(deleted|removed)$/i.test(st.trim())) return false;
  return true;
}

function accountsFromSnapshot(snap: unknown): Record<string, unknown>[] {
  if (!isRecord(snap)) return [];
  const raw = snap.accounts ?? snap.tradelines ?? snap.items;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

function detectReinsertedAccount(caseState: Record<string, unknown>): boolean {
  if (truthyFlag(caseState.reinserted_account) || truthyFlag(caseState.is_reinserted)) return true;

  const snaps = caseState.snapshots ?? caseState.report_snapshots ?? caseState.credit_snapshots;
  if (!Array.isArray(snaps) || snaps.length < 2) return false;

  for (let i = 0; i < snaps.length - 1; i++) {
    const older = accountsFromSnapshot(snaps[i]);
    const newer = accountsFromSnapshot(snaps[i + 1]);
    const olderMap = new Map<string, Record<string, unknown>>();
    for (const a of older) {
      const id = accountId(a);
      if (id) olderMap.set(id, a);
    }
    for (const a of newer) {
      const id = accountId(a);
      if (!id) continue;
      const prev = olderMap.get(id);
      if (prev && accountMarkedDeleted(prev) && accountActiveOnReport(a)) return true;
    }
  }
  return false;
}

function inquiriesList(caseState: Record<string, unknown>): Record<string, unknown>[] {
  const raw = caseState.inquiries ?? caseState.hard_inquiries ?? caseState.credit_inquiries;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

function identityTheftContext(caseState: Record<string, unknown>): boolean {
  return truthyFlag(caseState.identity_theft) ||
    truthyFlag(caseState.identity_theft_context) ||
    truthyFlag(caseState.fraud_alert_active) ||
    truthyFlag(caseState.initial_fraud_alert);
}

function inquiryExplicitlyUnauthorized(q: Record<string, unknown>): boolean {
  if (truthyFlag(q.unauthorized)) return true;
  if (truthyFlag(q.not_authorized)) return true;
  const auth = q.authorized ?? q.permissible ?? q.is_authorized;
  if (auth === false) return true;
  if (typeof auth === "string" && /^(no|false|0)$/i.test(auth.trim())) return true;
  return false;
}

/**
 * unauthorized_inquiry: at least one inquiry marked not authorized,
 * OR identity-theft context AND at least one inquiry explicitly flagged fraud-related.
 */
function detectUnauthorizedInquiry(caseState: Record<string, unknown>): boolean {
  const list = inquiriesList(caseState);
  if (list.length === 0) return false;

  for (const q of list) {
    if (inquiryExplicitlyUnauthorized(q)) return true;
  }

  if (!identityTheftContext(caseState)) return false;
  for (const q of list) {
    if (truthyFlag(q.dispute_fraud) || truthyFlag(q.identity_theft_related) || truthyFlag(q.fraudulent_inquiry)) {
      return true;
    }
  }
  return false;
}

function lateCount(acc: Record<string, unknown>, key: string): number {
  const v = num(acc[key]);
  return v !== null && v > 0 ? v : 0;
}

function accountHasLateBucket(acc: Record<string, unknown>): boolean {
  if (lateCount(acc, "times_30_days_late") > 0) return true;
  if (lateCount(acc, "times_60_days_late") > 0) return true;
  if (lateCount(acc, "times_90_days_late") > 0) return true;
  if (lateCount(acc, "times_120_days_late") > 0) return true;
  if (lateCount(acc, "late_30_count") > 0) return true;
  if (lateCount(acc, "late_60_count") > 0) return true;
  if (lateCount(acc, "late_90_count") > 0) return true;
  if (lateCount(acc, "late_120_count") > 0) return true;

  const worst = num(acc.worst_payment_status_code ?? acc.worst_delinquency_days);
  if (worst !== null && worst >= 30) return true;

  const ph = acc.payment_history ?? acc.payment_history_string;
  if (typeof ph === "string" && /\b(30|60|90|120)\s*(?:day)?s?\s*late\b/i.test(ph)) return true;

  const del = acc.delinquencies ?? acc.delinquency_history;
  if (Array.isArray(del)) {
    for (const d of del) {
      if (!isRecord(d)) continue;
      const days = num(d.days_late ?? d.days ?? d.late_days);
      if (days !== null && days >= 30) return true;
    }
  }
  return false;
}

function detectLatePayment(caseState: Record<string, unknown>): boolean {
  const accounts = caseState.accounts ?? caseState.tradelines;
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (isRecord(a) && accountHasLateBucket(a)) return true;
    }
  }
  if (accountHasLateBucket(caseState)) return true;
  return false;
}

function detectIdentityTheftAccounts(caseState: Record<string, unknown>): boolean {
  if (truthyFlag(caseState.ftc_report) || truthyFlag(caseState.has_ftc_report)) return true;
  if (truthyFlag(caseState.ftc_affidavit) || truthyFlag(caseState.ftc_identity_theft_report)) return true;
  if (truthyFlag(caseState.fraud_flag) || truthyFlag(caseState.fraud_alert)) return true;

  const n = num(caseState.unfamiliar_accounts_count);
  if (n !== null && n >= 2) return true;
  const unf = caseState.unfamiliar_accounts ?? caseState.unrecognized_accounts;
  if (Array.isArray(unf) && unf.length >= 2) return true;
  return false;
}

function collectAccounts(caseState: Record<string, unknown>): Record<string, unknown>[] {
  const accounts = caseState.accounts ?? caseState.tradelines;
  if (Array.isArray(accounts)) return accounts.filter(isRecord);
  return [];
}

function detectDuplicateCollection(caseState: Record<string, unknown>): boolean {
  const accounts = collectAccounts(caseState);
  const collections = accounts.filter((a) => {
    const t = a.account_type ?? a.type ?? a.category;
    if (typeof t === "string" && /collection/i.test(t)) return true;
    return truthyFlag(a.is_collection);
  });
  if (collections.length < 2) return false;

  const byCred = new Map<string, Record<string, unknown>[]>();
  for (const a of collections) {
    const name = normCreditor(a.creditor_name ?? a.creditor ?? a.furnisher_name ?? a.name);
    if (!name) continue;
    const g = byCred.get(name) ?? [];
    g.push(a);
    byCred.set(name, g);
  }
  for (const group of byCred.values()) {
    if (group.length < 2) continue;
    const balances = group.map((a) => num(a.balance ?? a.current_balance)).filter((b): b is number => b !== null && b > 0);
    if (balances.length < 2) continue;
    for (let i = 0; i < balances.length; i++) {
      for (let j = i + 1; j < balances.length; j++) {
        if (balancesSimilar(balances[i], balances[j])) return true;
      }
    }
  }
  return false;
}

function detectInconsistentStatus(caseState: Record<string, unknown>): boolean {
  if (truthyFlag(caseState.open_closed_conflict) || truthyFlag(caseState.status_conflict)) return true;

  const accounts = collectAccounts(caseState);
  for (const a of accounts) {
    if (truthyFlag(a.status_inconsistent) || truthyFlag(a.conflicting_status_fields)) return true;
    const cf = a.conflicting_fields;
    if (Array.isArray(cf) && cf.some((x) => /status|open|closed|paid/i.test(String(x)))) return true;

    const closed = truthyFlag(a.is_closed) || truthyFlag(a.closed) ||
      (typeof a.closed_date === "string" && a.closed_date.trim() !== "");
    const open = typeof a.status === "string" && /^open$/i.test(a.status.trim());
    if (closed && open) return true;

    const bal = num(a.balance ?? a.current_balance) ?? 0;
    const paidFull = truthyFlag(a.paid_in_full) || truthyFlag(a.paid_off);
    if (paidFull && bal > 0) return true;
  }
  return false;
}

function detectMissingCreditReport(caseState: Record<string, unknown>): boolean {
  if (truthyFlag(caseState.credit_report_unavailable)) return true;
  if (truthyFlag(caseState.bureau_report_unavailable)) return true;
  if (truthyFlag(caseState.cannot_access_report)) return true;
  if (truthyFlag(caseState.report_access_denied)) return true;

  const accessVals = new Set(["denied", "unavailable", "no_access", "no_file"]);
  const st = caseState.report_access ?? caseState.credit_report_status;
  if (typeof st === "string" && accessVals.has(st.trim().toLowerCase())) return true;

  const errs = caseState.bureau_errors ?? caseState.report_errors;
  const errCodes = new Set([
    "no_file",
    "unavailable",
    "access_denied",
    "report_unavailable",
    "cannot_access",
    "bureau_unavailable",
  ]);
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (typeof e === "string" && errCodes.has(e.trim().toLowerCase())) return true;
      if (isRecord(e)) {
        const code = e.code ?? e.reason;
        if (typeof code === "string" && errCodes.has(code.trim().toLowerCase())) return true;
      }
    }
  }
  return false;
}

/** Walk observations for explicit trigger id fields only (no text inference). */
function findingTriggersFromObservations(observations: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (o: unknown) => {
    if (o === null || o === undefined) return;
    if (typeof o === "string") {
      if ((KNOWN_TRIGGERS as readonly string[]).includes(o)) out.add(o);
      return;
    }
    if (!isRecord(o)) return;
    const t = o.trigger ?? o.type ?? o.code ?? o.finding ?? o.id;
    if (typeof t === "string" && (KNOWN_TRIGGERS as readonly string[]).includes(t)) out.add(t);
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (isRecord(v)) visit(v);
    }
  };
  asArray(observations).forEach(visit);
  return out;
}

function combinedObservations(caseState: CreditCaseState, observations: CreditObservations): unknown[] {
  const fromCs = isRecord(caseState) ? asArray(caseState.observations) : [];
  const fromArg = asArray(observations);
  return [...fromCs, ...fromArg];
}

/**
 * Deterministic trigger detection from structured case state and parsed observations.
 * Returns canonical trigger ids in stable order; empty array if none match with certainty.
 */
export function detectCreditTriggers(
  caseState: CreditCaseState,
  observations: CreditObservations,
): string[] {
  const cs: Record<string, unknown> = isRecord(caseState) ? { ...caseState } : {};

  const obsCombined = combinedObservations(caseState, observations);
  const fromFindings = findingTriggersFromObservations(
    obsCombined.length ? obsCombined : observations,
  );

  const out = new Set<string>(fromFindings);

  if (detectReinsertedAccount(cs)) out.add("reinserted_account");
  if (detectUnauthorizedInquiry(cs)) out.add("unauthorized_inquiry");
  if (detectLatePayment(cs)) out.add("late_payment");
  if (detectIdentityTheftAccounts(cs)) out.add("identity_theft_account_present");
  if (detectDuplicateCollection(cs)) out.add("duplicate_collection");
  if (detectInconsistentStatus(cs)) out.add("inconsistent_status");
  if (detectMissingCreditReport(cs)) out.add("missing_credit_report");

  return KNOWN_TRIGGERS.filter((t) => out.has(t));
}

export type DocClass =
  | "income_1099"         // 1099-NEC, 1099-MISC, 1099-K, 1099-INT, 1099-DIV, 1099-B, 1099-R, 1099-G, SSA-1099
  | "income_w2"           // W-2 wage statement
  | "financial_statement" // bank statement, credit card statement, brokerage statement, any monthly/quarterly account summary
  | "receipt_or_invoice"  // expense receipts, vendor invoices, utility bills (deductible business expenses)
  | "tax_form"            // 1040, Schedule C, Schedule SE, prior-year returns, K-1s, property tax bills
  | "identity_or_legal"   // ID, SSN card, LLC formation docs, EIN letter — no dollar figures to extract
  | "unknown";

export interface DocClassificationInput {
  filename: string;
  mimeType?: string;
  textSample?: string; // first ~2000 chars of extracted text, if available
}

export interface DocClassification {
  docClass: DocClass;
  confidence: "high" | "medium" | "low";
  reasons: string[]; // human-readable evidence, e.g. ["filename contains '1099-NEC'", "text contains 'Nonemployee compensation'"]
}

export function classifyDocument(input: DocClassificationInput): DocClassification {
  try {
    const filename = (input.filename || "").toLowerCase();
    const text = (input.textSample || "").toLowerCase();

    let filenameClass: DocClass | null = null;
    let textClass: DocClass | null = null;
    const filenameReasons: string[] = [];
    const textReasons: string[] = [];

    // --- Filename heuristics ---

    if (filename.includes("1099")) {
      filenameClass = "income_1099";
      if (filename.includes("-nec") || filename.includes("nec")) {
        filenameReasons.push("filename contains '1099' (subtype: NEC)");
      } else if (filename.includes("-k") || filename.includes("1099k")) {
        filenameReasons.push("filename contains '1099' (subtype: K)");
      } else if (filename.includes("-misc") || filename.includes("misc")) {
        filenameReasons.push("filename contains '1099' (subtype: MISC)");
      } else if (filename.includes("-int") || filename.includes("1099int")) {
        filenameReasons.push("filename contains '1099' (subtype: INT)");
      } else if (filename.includes("-div") || filename.includes("1099div")) {
        filenameReasons.push("filename contains '1099' (subtype: DIV)");
      } else if (filename.includes("-b") || filename.includes("1099b")) {
        filenameReasons.push("filename contains '1099' (subtype: B)");
      } else if (filename.includes("-r") || filename.includes("1099r")) {
        filenameReasons.push("filename contains '1099' (subtype: R)");
      } else if (filename.includes("-g") || filename.includes("1099g")) {
        filenameReasons.push("filename contains '1099' (subtype: G)");
      } else {
        filenameReasons.push("filename contains '1099'");
      }
    } else if (filename.includes("ssa-1099") || filename.includes("ssa1099")) {
      filenameClass = "income_1099";
      filenameReasons.push("filename contains 'SSA-1099'");
    } else if (filename.includes("w-2") || filename.includes("w2")) {
      filenameClass = "income_w2";
      filenameReasons.push(`filename contains '${filename.includes("w-2") ? "w-2" : "w2"}'`);
    } else if (
      filename.includes("statement") ||
      filename.includes("stmt") ||
      filename.includes("checking") ||
      filename.includes("savings") ||
      filename.includes("brokerage") ||
      filename.includes("credit card") ||
      filename.includes("visa") ||
      filename.includes("mastercard") ||
      filename.includes("amex")
    ) {
      filenameClass = "financial_statement";
      const matched = ["statement", "stmt", "checking", "savings", "brokerage", "credit card", "visa", "mastercard", "amex"].find(
        (kw) => filename.includes(kw)
      );
      filenameReasons.push(`filename contains '${matched}'`);
    } else if (
      filename.includes("receipt") ||
      filename.includes("invoice") ||
      filename.includes("bill")
    ) {
      filenameClass = "receipt_or_invoice";
      const matched = ["receipt", "invoice", "bill"].find((kw) => filename.includes(kw));
      filenameReasons.push(`filename contains '${matched}'`);
    } else if (
      filename.includes("1040") ||
      filename.includes("schedule c") ||
      filename.includes("schedule se") ||
      filename.includes("k-1") ||
      filename.includes("k1") ||
      filename.includes("property tax")
    ) {
      filenameClass = "tax_form";
      const matched = ["1040", "schedule c", "schedule se", "k-1", "k1", "property tax"].find(
        (kw) => filename.includes(kw)
      );
      filenameReasons.push(`filename contains '${matched}'`);
    } else if (
      filename.includes(" id") ||
      filename.startsWith("id") ||
      filename.includes("license") ||
      filename.includes("passport") ||
      filename.includes("ssn") ||
      filename.includes("ein") ||
      filename.includes("llc") ||
      filename.includes("formation") ||
      filename.includes("articles")
    ) {
      filenameClass = "identity_or_legal";
      const matched = [" id", "id", "license", "passport", "ssn", "ein", "llc", "formation", "articles"].find(
        (kw) => filename.includes(kw)
      );
      filenameReasons.push(`filename contains '${matched?.trim()}'`);
    }

    // --- Text-sample confirmation ---

    if (text) {
      if (
        text.includes("nonemployee compensation") ||
        text.includes("payer's tin") ||
        text.includes("recipient's tin")
      ) {
        textClass = "income_1099";
        const matched = ["nonemployee compensation", "payer's tin", "recipient's tin"].filter((p) =>
          text.includes(p)
        );
        textReasons.push(...matched.map((p) => `text contains '${p}'`));
      } else if (
        text.includes("wages, tips, other compensation") ||
        text.includes("employer identification number")
      ) {
        textClass = "income_w2";
        const matched = ["wages, tips, other compensation", "employer identification number"].filter(
          (p) => text.includes(p)
        );
        textReasons.push(...matched.map((p) => `text contains '${p}'`));
      } else if (
        text.includes("beginning balance") ||
        text.includes("ending balance") ||
        text.includes("deposits and credits") ||
        text.includes("statement period")
      ) {
        textClass = "financial_statement";
        const matched = ["beginning balance", "ending balance", "deposits and credits", "statement period"].filter(
          (p) => text.includes(p)
        );
        textReasons.push(...matched.map((p) => `text contains '${p}'`));
      } else if (
        text.includes("invoice") ||
        text.includes("bill to") ||
        text.includes("amount due") ||
        text.includes("subtotal")
      ) {
        textClass = "receipt_or_invoice";
        const matched = ["invoice", "bill to", "amount due", "subtotal"].filter((p) =>
          text.includes(p)
        );
        textReasons.push(...matched.map((p) => `text contains '${p}'`));
      }
    }

    // --- Determine final class and confidence ---

    const allReasons = [...filenameReasons, ...textReasons];

    if (filenameClass !== null && textClass !== null) {
      if (filenameClass === textClass) {
        return { docClass: filenameClass, confidence: "high", reasons: allReasons };
      } else {
        // Conflicting signals — prefer filename but downgrade confidence
        return {
          docClass: filenameClass,
          confidence: "low",
          reasons: [
            ...allReasons,
            `conflicting signals: filename suggests ${filenameClass}, text suggests ${textClass}`,
          ],
        };
      }
    }

    if (filenameClass !== null) {
      return { docClass: filenameClass, confidence: "medium", reasons: filenameReasons };
    }

    if (textClass !== null) {
      return { docClass: textClass, confidence: "medium", reasons: textReasons };
    }

    return { docClass: "unknown", confidence: "low", reasons: ["no matching signals in filename or text sample"] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { docClass: "unknown", confidence: "low", reasons: [`classifier error: ${msg}`] };
  }
}

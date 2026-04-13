import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

export type PdfPage = {
  pageNumber: number;
  pdfBuffer: Uint8Array;
  text?: string;
  imageBuffer?: Uint8Array;
};

export async function splitPdfIntoPages(buffer: Uint8Array): Promise<PdfPage[]> {
  const src = await PDFDocument.load(buffer);
  const pages: PdfPage[] = [];
  const pageCount = src.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(src, [i]);
    out.addPage(copied);
    const bytes = await out.save();
    pages.push({
      pageNumber: i + 1,
      pdfBuffer: bytes,
    });
  }
  return pages;
}

export function isScannedPage(page: PdfPage): boolean {
  const t = (page.text ?? "").trim();
  return t.length < 50;
}

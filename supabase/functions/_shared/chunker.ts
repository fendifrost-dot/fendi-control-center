import type { PdfPage } from "./pdfSplitter.ts";

export type PageChunk = {
  index: number;
  pages: PdfPage[];
};

export function chunkPages(pages: PdfPage[], size = 10): PageChunk[] {
  const out: PageChunk[] = [];
  for (let i = 0; i < pages.length; i += size) {
    out.push({
      index: Math.floor(i / size),
      pages: pages.slice(i, i + size),
    });
  }
  return out;
}

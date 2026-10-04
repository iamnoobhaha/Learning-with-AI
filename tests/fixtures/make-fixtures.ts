/**
 * Generates small deterministic fixtures for tests.
 * Writes a multi-page PDF, a PPTX with slides (including an image-only slide),
 * and a plain-text file into tests/fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;
  // 1 catalog, 2 pages tree, then per page: page obj + content obj, font last.
  const firstPageObj = 3;
  const fontObj = 3 + pageCount * 2;
  const total = fontObj; // highest object number

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages
    .map((_, i) => `${firstPageObj + i * 2} 0 R`)
    .join(" ")}] /Count ${pageCount} >>`;

  pages.forEach((text, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const lines = text.split("\n");
    const body = lines
      .map((line, li) => `BT /F1 12 Tf 72 ${720 - li * 16} Td (${esc(line)}) Tj ET`)
      .join("\n");
    const stream = `${body}\n`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  });

  objects[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  // Build the file once as latin1 so byte offsets match what we record.
  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, "latin1"));
  let length = 0;
  const offsets = new Map<number, number>();

  push("%PDF-1.4\n");
  length += Buffer.byteLength("%PDF-1.4\n", "latin1");

  for (let i = 1; i <= total; i++) {
    const body = objects[i];
    if (!body) continue;
    offsets.set(i, length);
    const piece = `${i} 0 obj\n${body}\nendobj\n`;
    push(piece);
    length += Buffer.byteLength(piece, "latin1");
  }

  const xrefStart = length;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    xref += `${String(offsets.get(i) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(xref);
  return Buffer.concat(chunks);
}

export async function makePptx(
  slides: { title?: string; bullets?: string[]; image?: boolean; notes?: string }[]
): Promise<Buffer> {
  const zip = new JSZip();

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slides
    .map(
      (_, i) =>
        `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`
    )
    .join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`;
  zip.file("ppt/presentation.xml", presentation);

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    )
    .join("")}</Relationships>`;
  zip.file("ppt/_rels/presentation.xml.rels", rels);

  slides.forEach((slide, i) => {
    const paragraphs = [
      slide.title,
      ...(slide.bullets ?? []),
    ].filter(Boolean);
    const paraXml = paragraphs
      .map(
        (t) =>
          `<a:p><a:r><a:t>${String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a:t></a:r></a:p>`
      )
      .join("");
    const pic = slide.image
      ? `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture 8"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr/></p:pic>`
      : "";
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${paraXml}${pic}</p:spTree></p:cSld></p:sld>`;
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);

    const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      slide.notes
        ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`
        : ""
    }${
      slide.image
        ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
        : ""
    }</Relationships>`;
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels);

    if (slide.notes) {
      const notesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><a:p><a:r><a:t>${slide.notes}</a:t></a:r></a:p></p:spTree></p:cSld></p:notes>`;
      zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, notesXml);
    }
  });

  if (slides.some((s) => s.image)) {
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    zip.file("ppt/media/image1.png", png);
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

export function writeFixtures(): Promise<string> {
  fs.mkdirSync(FIXTURES, { recursive: true });

  fs.writeFileSync(
    path.join(FIXTURES, "sample.pdf"),
    makePdf([
      "Operating Systems - Page 1\nA process is a program in execution.\nThe PCB holds process state.",
      "Operating Systems - Page 2\nScheduling policies decide CPU order.\nRound robin uses a time quantum.\nMonday 14:00 - 15:30 Room B204\nInstructor: Dr Smith\nOffice hours: Tuesday 10:00-12:00",
      "",
      "Operating Systems - Page 4\nDeadlock needs four conditions: mutual exclusion, hold and wait,\nno preemption and circular wait.",
    ])
  );

  fs.writeFileSync(
    path.join(FIXTURES, "sample-notes.txt"),
    "Physics Lecture Notes\n\n# Photosynthesis\nPlants convert light energy into chemical energy stored as glucose. Chlorophyll absorbs photons in the chloroplasts.\n\n# Binary Search\nBinary search finds an element in a sorted array in O(log n) time by halving the search interval each step."
  );

  return makePptx([
    { title: "Intro", bullets: ["Welcome to the course", "Course outline"] },
    { title: "Memory Management", bullets: ["Paging", "Segmentation"], image: true },
    { bullets: [], image: true, notes: "Discussion of the memory diagram" },
  ]).then((pptx) => {
    fs.writeFileSync(path.join(FIXTURES, "sample.pptx"), pptx);
    return FIXTURES;
  });
}

// Allow direct execution: npx tsx tests/fixtures/make-fixtures.ts
if (process.argv[1]?.endsWith("make-fixtures.ts")) {
  void writeFixtures().then((dir) => console.log("fixtures written to", dir));
}
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractPdf, extractPptx, extractPlain, isPasswordError } from "@/lib/extract";

const FIX = path.join(process.cwd(), "tests", "fixtures");
const pdf = () => fs.readFileSync(path.join(FIX, "sample.pdf"));
const pptx = () => fs.readFileSync(path.join(FIX, "sample.pptx"));

describe("PDF page mapping", () => {
  it("produces one unit per page and never shifts numbering when a page is empty", async () => {
    const result = await extractPdf(pdf());
    // Fixture has 4 pages, page 3 deliberately has no text.
    expect(result.pageCount).toBe(4);
    expect(result.units).toHaveLength(4);
    expect(result.units.map((u) => u.number)).toEqual([1, 2, 3, 4]);
    expect(result.units.map((u) => u.label)).toEqual([
      "Page 1",
      "Page 2",
      "Page 3",
      "Page 4",
    ]);
  });

  it("keeps an empty page in the output and marks it no_text rather than dropping it", async () => {
    const result = await extractPdf(pdf());
    const page3 = result.units.find((u) => u.number === 3)!;
    expect(page3).toBeDefined();
    expect(page3.text).toBe("");
    expect(page3.status).toBe("no_text");
    // Pages after the empty one keep their own text.
    expect(result.units.find((u) => u.number === 4)!.text).toContain("Deadlock");
  });

  it("extracts real text from normal pages", async () => {
    const result = await extractPdf(pdf());
    const page1 = result.units.find((u) => u.number === 1)!;
    expect(page1.status).toBe("ok");
    expect(page1.text).toContain("process is a program in execution");
  });

  it("rejects a corrupt PDF with a helpful error instead of throwing raw internals", async () => {
    const broken = Buffer.from("%PDF-1.4\nthis is not really a pdf body");
    await expect(extractPdf(broken)).rejects.toThrow(/could not read this pdf/i);
  });
});

describe("PDF failure classification", () => {
  const passwordException = (message: string) =>
    Object.assign(new Error(message), { name: "PasswordException" });

  it("reports a missing or wrong reader password as a password error", () => {
    expect(isPasswordError(passwordException("No password given"))).toBe(true);
    expect(isPasswordError(new Error("Incorrect password"))).toBe(true);
  });

  it("does not misclassify other parse failures", () => {
    expect(isPasswordError(new Error("Invalid PDF structure"))).toBe(false);
    expect(isPasswordError(new Error("bad XRef entry"))).toBe(false);
    expect(isPasswordError(null)).toBe(false);
    expect(isPasswordError("boom")).toBe(false);
  });
});

describe("PPTX slide mapping", () => {
  it("creates one unit per slide with stable numbering", async () => {
    const result = await extractPptx(pptx());
    expect(result.pageCount).toBe(3);
    expect(result.units.map((u) => u.number)).toEqual([1, 2, 3]);
    expect(result.units.map((u) => u.label)).toEqual([
      "Slide 1",
      "Slide 2",
      "Slide 3",
    ]);
  });

  it("does not drop a slide that has no text run (image-only)", async () => {
    const result = await extractPptx(pptx());
    const slide3 = result.units.find((u) => u.number === 3)!;
    expect(slide3).toBeDefined();
    // Body text empty, but slide still present and flagged.
    expect(slide3.status).toBe("no_text");
    expect(slide3.slide?.hasImage).toBe(true);
  });

  it("captures title, bullets and image flags for a structured preview", async () => {
    const result = await extractPptx(pptx());
    const slide2 = result.units.find((u) => u.number === 2)!;
    expect(slide2.slide?.title).toBe("Memory Management");
    expect(slide2.slide?.bullets).toEqual(["Paging", "Segmentation"]);
    expect(slide2.slide?.hasImage).toBe(true);
  });

  it("stores speaker notes separately from slide body text", async () => {
    const result = await extractPptx(pptx());
    const slide3 = result.units.find((u) => u.number === 3)!;
    expect(slide3.slide?.notes).toContain("memory diagram");
    // Notes are appended to the page text under a clear label for AI context.
    expect(slide3.text).toContain("[Speaker notes]");
  });

  it("rejects a malformed pptx gracefully", async () => {
    const broken = Buffer.from("PK\u0003\u0004 not a real zip");
    await expect(extractPptx(broken)).rejects.toThrow(/could not be opened|corrupt/i);
  });
});

describe("Plain text sections", () => {
  it("splits on headings into numbered sections", () => {
    const result = extractPlain(
      Buffer.from(
        "Header\nintro text here that is long enough to matter\n\n# Photosynthesis\nPlants convert light into glucose using chlorophyll.\n\n# Search\nBinary search halves the interval each step."
      )
    );
    expect(result.pageModel).toBe("sectioned");
    expect(result.units.length).toBeGreaterThanOrEqual(2);
    expect(result.units[0].number).toBe(1);
    expect(result.units.map((u) => u.number)).toEqual(
      result.units.map((_, i) => i + 1)
    );
  });
});
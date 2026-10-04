import { describe, it, expect } from "vitest";
import { detectLowValue } from "@/lib/quality";
import type { ExtractedUnit } from "@/lib/extract";

function unit(text: string, number = 1): ExtractedUnit {
  return { number, type: "pdf_page", label: `Page ${number}`, text, status: text ? "ok" : "no_text" };
}

describe("low-value suggestions (never deletions)", () => {
  it("never suggests excluding a page that has no text", () => {
    // Image-only pages must stay visible and reviewable.
    const v = detectLowValue(unit(""));
    expect(v.suggestExclude).toBe(false);
    expect(v.signals).toContain("no_text");
  });

  it("suggests exclusion for a pure timetable entry and explains why", () => {
    const v = detectLowValue(
      unit("Monday 14:00 - 15:30 Room B204\nTuesday 10:00 - 11:30 Room A101")
    );
    expect(v.suggestExclude).toBe(true);
    expect(v.reason).toMatch(/timetable|scheduled time/i);
  });

  it("suggests exclusion for admin-only boilerplate", () => {
    const v = detectLowValue(
      unit("Instructor: Dr Smith\nOffice hours: Tuesday 10:00-12:00\nDue date: Friday 11:59 PM")
    );
    expect(v.suggestExclude).toBe(true);
    expect(v.reason).toBeTruthy();
  });

  it("does NOT suggest exclusion for a short but academically important definition", () => {
    const v = detectLowValue(
      unit("Entropy is a measure of the number of microstates consistent with a system macrostate.")
    );
    expect(v.suggestExclude).toBe(false);
  });

  it("does NOT suggest exclusion for content that mixes admin framing with real explanation", () => {
    const v = detectLowValue(
      unit(
        "Lecture 3\nMonday 14:00 - 15:30\n" +
          "Photosynthesis is the process by which plants convert light energy into chemical energy " +
          "stored as glucose. Chlorophyll within the chloroplasts absorbs photons that excite " +
          "electrons, and the electron transport chain uses that energy to synthesise ATP."
      )
    );
    expect(v.suggestExclude).toBe(false);
  });

  it("does NOT suggest exclusion for code", () => {
    const v = detectLowValue(
      unit("def quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    return quicksort(arr[1:])")
    );
    expect(v.suggestExclude).toBe(false);
  });

  it("does NOT suggest exclusion for formulas and numbered procedures", () => {
    const v1 = detectLowValue(unit("F = ma\nE = mc^2\nV = IR\nP = VI"));
    expect(v1.suggestExclude).toBe(false);
    const v2 = detectLowValue(
      unit("1. Open the file\n2. Select the range\n3. Click Export\n4. Confirm the format")
    );
    expect(v2.suggestExclude).toBe(false);
  });

  it("does NOT suggest exclusion for historical dates and timelines", () => {
    const v = detectLowValue(
      unit(
        "The Industrial Revolution began in Britain around 1760 and spread to Europe and North America " +
          "throughout the nineteenth century, transforming manufacturing, transport and urban life."
      )
    );
    expect(v.suggestExclude).toBe(false);
  });

  it("does NOT suggest exclusion for a sparse but valid presentation slide", () => {
    const v = detectLowValue(unit("Paging"));
    expect(v.suggestExclude).toBe(false);
  });

  it("always returns a reason when it suggests exclusion", () => {
    for (const text of [
      "Monday 14:00 - 15:30 Room B204",
      "Instructor: Dr Smith\nDue date: Friday",
      "Copyright 2024 All rights reserved",
    ]) {
      const v = detectLowValue(unit(text));
      if (v.suggestExclude) expect(v.reason).toBeTruthy();
    }
  });
});
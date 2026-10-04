import { describe, it, expect } from "vitest";
import {
  nextSchedule,
  boxFor,
  intervalForBox,
  isDue,
  intervalLabel,
  dueLabel,
  MIN_EASE,
} from "@/lib/srs";
import { dedupeAgainst, normalizeText, fingerprint, tokenSet, similarity } from "@/lib/dedup";

const now = new Date("2026-09-10T12:00:00Z");

describe("spaced repetition scheduling", () => {
  it("graduates a new card to one day when known", () => {
    const r = nextSchedule({ interval: 0, ease: 2.5, reps: 0, lapses: 0 }, "know", now);
    expect(r.interval).toBe(1);
    expect(r.dueAt).toBe("2026-09-11 12:00:00");
    expect(r.reps).toBe(1);
  });

  it("expands the interval by the ease factor once learned", () => {
    const r = nextSchedule({ interval: 7, ease: 2.5, reps: 5, lapses: 0 }, "know", now);
    expect(r.interval).toBe(18); // round(7 * 2.5)
  });

  it("records a lapse and lowers ease when forgotten", () => {
    const r = nextSchedule({ interval: 21, ease: 2.5, reps: 8, lapses: 0 }, "again", now);
    expect(r.interval).toBe(0);
    expect(r.lapses).toBe(1);
    expect(r.ease).toBeCloseTo(2.3);
    expect(r.dueAt).toBe("2026-09-10 12:10:00"); // learning step
  });

  it("never lets ease fall below the floor", () => {
    let s = { interval: 0, ease: 1.5, reps: 0, lapses: 0 };
    for (let i = 0; i < 5; i++) s = nextSchedule(s, "again", now);
    expect(s.ease).toBe(MIN_EASE);
  });

  it("maps intervals to Leitner boxes consistently", () => {
    expect(boxFor(0)).toBe(0);
    expect(boxFor(1)).toBe(1);
    expect(boxFor(7)).toBe(3);
    expect(boxFor(21)).toBe(4);
    expect(boxFor(60)).toBe(5);
    for (const i of [0, 1, 7, 21, 60]) expect(intervalForBox(boxFor(i))).toBe(i);
  });

  it("treats unscheduled cards as due immediately", () => {
    expect(isDue("")).toBe(true);
    expect(isDue("2026-09-10 11:00:00", now)).toBe(true);
    expect(isDue("2026-09-10 13:00:00", now)).toBe(false);
  });

  it("labels intervals in human terms", () => {
    expect(intervalLabel(0)).toBe("Learning");
    expect(intervalLabel(1)).toBe("1 day");
    expect(intervalLabel(14)).toBe("2 weeks");
    expect(dueLabel("2026-09-10 11:00:00")).toMatch(/due now|ago/);
  });
});

describe("deduplication", () => {
  it("normalises case and punctuation for fingerprinting", () => {
    expect(fingerprint("What is a Process?")).toBe("whatisaprocess");
    expect(normalizeText("A, B. C!")).toBe("a b c");
  });

  it("computes jaccard similarity between token sets", () => {
    const a = tokenSet("binary search finds an element in a sorted array");
    const b = tokenSet("binary search finds an element in a sorted array");
    expect(similarity(a, b)).toBeCloseTo(1);
    const c = tokenSet("photosynthesis converts light energy into glucose");
    expect(similarity(a, c)).toBe(0);
  });

  it("removes exact and near duplicates against prior items", () => {
    const existing = [
      "Binary search finds an element in a sorted array in O(log n) time.",
      "What is the overall reaction of photosynthesis?",
    ];
    const candidates = [
      { p: "Binary search finds an element in a sorted array in O(log n) time." }, // exact
      { p: "Binary search finds an element in a sorted array in O(log n) time?" }, // punctuation
      { p: "Which organisms carry out photosynthesis?" }, // fresh
      { p: "How does chlorophyll behave during light absorption?" }, // fresh
      { p: "What is the overall reaction of photosynthesis?" }, // exact dup
    ];
    const r = dedupeAgainst(candidates, (c) => c.p, existing, 0.72);
    expect(r.fresh).toHaveLength(2);
    expect(r.duplicatesRemoved).toBe(3);
  });

  it("dedupes within a single batch too", () => {
    const r = dedupeAgainst(
      [{ p: "What is a mutex?" }, { p: "What is a mutex?" }, { p: "What is a semaphore?" }],
      (c) => c.p,
      [],
      0.72
    );
    expect(r.fresh).toHaveLength(2);
    expect(r.duplicatesRemoved).toBe(1);
  });
});
import type { ExtractedUnit } from "./extract";

/**
 * Low-value *suggestions*, never deletions.
 *
 * Earlier versions physically stripped or discarded "junk" content at upload
 * time, which destroyed source material the user could never inspect or
 * recover. Now every page is stored verbatim; we only attach a suggestion flag
 * and a human-readable reason which the selector surfaces for one-click
 * acceptance. Short text is never treated as unimportant on its own, because a
 * definition slide or a one-line formula can be exactly what a student needs.
 */

export interface QualityVerdict {
  suggestExclude: boolean;
  reason: string | null;
  signals: string[];
}

interface Rule {
  id: string;
  reason: string;
  test: RegExp;
  /** Weight towards the exclude suggestion. */
  weight: number;
}

/**
 * Deliberately narrow: these match administrative framing, not subject matter.
 * Anything resembling a date, timeline, numbered procedure, formula or code is
 * excluded from this rule set to avoid false positives on real content.
 */
const RULES: Rule[] = [
  {
    id: "schedule_slot",
    reason: "Looks like a timetable entry (day and time range)",
    test: /\b(mon|tue|wed|thu|fri|sat|sun)(day|s|nes|rs|ur|day)?\b[^\n]{0,24}\b\d{1,2}[:.]\d{2}\b/i,
    weight: 2,
  },
  {
    id: "time_range",
    reason: "Looks like a scheduled time range rather than study content",
    test: /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\s*[-–—to]+\s*\d{1,2}[:.]\d{2}\b/i,
    weight: 2,
  },
  {
    id: "office_hours",
    reason: "Appears to be office hours or consultation logistics",
    test: /\b(office hours?|consultation|drop[- ]?in|help session)\b/i,
    weight: 3,
  },
  {
    id: "submission_logistics",
    reason: "Appears to be submission or deadline logistics",
    test: /\b(submit|submission|resubmit|upload|turn in)\b[^\n]{0,40}\b(date|deadline|by|before|on)\b/i,
    weight: 3,
  },
  {
    id: "assessment_admin",
    reason: "Appears to describe grading or attendance policy",
    test: /\b(attendance|participation|marking|grading)\b[^\n]{0,40}\b(policy|weight|worth|counts|%\b|cap)\b/i,
    weight: 3,
  },
  {
    id: "staff_contact",
    reason: "Appears to be staff contact details",
    test: /\b(instructor|lecturer|professor|tutor|coordinator)\b\s*[:\-–]/i,
    weight: 2,
  },
  {
    id: "admin_notice",
    reason: "Appears to be an administrative announcement",
    test: /\b(announcement|notice|reminder|important notice|please note)\b\s*[:\-–]/i,
    weight: 2,
  },
  {
    id: "lms_pointer",
    reason: "Points at an LMS portal rather than containing subject matter",
    test: /\b(course portal|blackboard|canvas|moodle|turnitin|classroom|zoom)\b/i,
    weight: 3,
  },
  {
    id: "copyright",
    reason: "Copyright / rights boilerplate",
    test: /copyright|all rights reserved|©/i,
    weight: 2,
  },
  {
    id: "bare_page_number",
    reason: "Contains only a page or slide number",
    test: /^\s*[-–—•*]?\s*(page|slide|part)?\s*\d+\s*(of\s+\d+)?\s*$/i,
    weight: 4,
  },
  {
    id: "bare_link",
    reason: "Contains only a link",
    test: /^\s*https?:\/\/\S+\s*$/i,
    weight: 4,
  },
];

const EXCLUDE_THRESHOLD = 3;

/** Content signals that indicate a page is real study material. */
function positiveSignals(unit: ExtractedUnit): number {
  let score = 0;
  const text = unit.text;

  // Real explanation prose: several sentences of ordinary words.
  const sentences = text.split(/[.!?]\s+/).filter((s) => s.trim().length > 20);
  if (sentences.length >= 3) score += 2;

  // Definitions, which are frequently short and must not be swept away.
  if (/\b(is|are|refers to|means|defined as|known as|consists of)\b/i.test(text)) score += 2;

  // Formulas / equations.
  if (/[=≈≤≥∑∫√±]|\b\w+\s*\(\s*[^)]*\)\s*=/.test(text)) score += 2;

  // Code or shell snippets.
  if (/^\s*(def |class |function |#include|import |SELECT |\{\s*$)/m.test(text)) score += 3;

  // Bulleted lists with substance.
  const bullets = text.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l));
  if (bullets.length >= 3) score += 2;

  // Diagrams or figures described in text.
  if (/\b(figure|fig\.|diagram|table|chart|graph|algorithm|step \d)\b/i.test(text)) score += 2;

  return score;
}

export function detectLowValue(unit: ExtractedUnit): QualityVerdict {
  const text = unit.text.trim();
  const signals: string[] = [];
  let weight = 0;

  // A page with no extractable text is never "excluded" — the user must be able
  // to see it and decide. It is usually a diagram or a scan.
  if (!text) {
    return { suggestExclude: false, reason: null, signals: ["no_text"] };
  }

  for (const rule of RULES) {
    if (rule.test.test(text)) {
      signals.push(rule.id);
      weight += rule.weight;
    }
  }

  if (weight < EXCLUDE_THRESHOLD) {
    return { suggestExclude: false, reason: null, signals };
  }

  const positive = positiveSignals(unit);
  if (positive >= 2) {
    // Mixed admin + substance: keep it, the user can still exclude it manually.
    return { suggestExclude: false, reason: null, signals };
  }

  const reasons = RULES.filter((r) => signals.includes(r.id)).map((r) => r.reason);
  const unique = Array.from(new Set(reasons));
  return {
    suggestExclude: true,
    reason: unique.join("; "),
    signals,
  };
}
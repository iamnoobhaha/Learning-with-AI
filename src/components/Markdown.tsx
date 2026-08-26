"use client";

import { Fragment, type ReactNode } from "react";

const INLINE_RE =
  /(\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_RE);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      return (
        <a
          key={key}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline decoration-indigo-500/40 transition hover:text-indigo-300"
        >
          {link[1]}
        </a>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{renderInline(part.slice(2, -2), `${key}-b`)}</strong>;
    }
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) {
      return <del key={key}>{part.slice(2, -2)}</del>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={key} className="rounded bg-zinc-800 px-1 py-0.5 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={key}>{renderInline(part.slice(1, -1), `${key}-i`)}</em>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function splitCells(line: string): string[] {
  let t = line.trim().replace(/\\\|/g, "\u0000");
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.replace(/\u0000/g, "|").trim());
}

function isDelimiterRow(line: string): boolean {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

type Align = "left" | "center" | "right";

function alignOf(cell: string): Align {
  const c = cell.trim();
  if (c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  return "left";
}

const HEADING_SIZES: Record<number, string> = {
  1: "mt-4 mb-2 text-xl font-bold",
  2: "mt-4 mb-2 text-lg font-semibold",
  3: "mt-3 mb-1.5 text-base font-semibold",
};

export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={i} className="ml-5">
        {renderInline(item, `${key}-li-${i}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key} className="my-2 list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-disc space-y-1">
          {items}
        </ul>
      )
    );
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push(
          <pre
            key={`code-${i}`}
            className="my-3 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-sm text-zinc-200"
          >
            <code>{code.join("\n")}</code>
          </pre>
        );
        code = null;
      } else {
        flushList(`list-${i}`);
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    // tables: header row with a pipe, delimiter row on the next non-blank line
    if (line.includes("|") && !line.trim().startsWith(">")) {
      let k = i + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k < lines.length && isDelimiterRow(lines[k])) {
        const header = splitCells(line);
        const aligns = splitCells(lines[k]).map(alignOf);
        const rows: string[][] = [];
        let j = k + 1;
        while (j < lines.length) {
          if (lines[j].trim() === "") {
            let m = j + 1;
            while (m < lines.length && lines[m].trim() === "") m++;
            if (
              m < lines.length &&
              lines[m].includes("|") &&
              !/^\s{0,3}(?:#{1,6}\s|>|```|\|?\s*:?-{2,})/.test(lines[m])
            ) {
              j = m;
              continue;
            }
            break;
          }
          if (!lines[j].includes("|")) break;
          rows.push(splitCells(lines[j]));
          j++;
        }
        const cellAlign = (ci: number) =>
          ci < aligns.length ? ({ textAlign: aligns[ci] } as const) : undefined;
        blocks.push(
          <div key={`tbl-${i}`} className="my-3 overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-zinc-900/80">
                  {header.map((h, ci) => (
                    <th
                      key={ci}
                      style={cellAlign(ci)}
                      className="border-b border-zinc-600 px-3 py-2 text-left font-semibold"
                    >
                      {renderInline(h, `tbl-${i}-h-${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-zinc-800/70 last:border-b-0">
                    {header.map((_, ci) => (
                      <td key={ci} style={cellAlign(ci)} className="px-3 py-2 align-top">
                        {renderInline(r[ci] ?? "", `tbl-${i}-r${ri}-c${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        i = j - 1;
        continue;
      }
    }

    // blockquotes
    if (line.trim().startsWith(">")) {
      flushList(`list-q-${i}`);
      const quote: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        quote.push(lines[j].replace(/^\s*>\s?/, ""));
        j++;
      }
      blocks.push(
        <blockquote
          key={`quote-${i}`}
          className="my-3 border-l-4 border-indigo-600/60 bg-zinc-900/60 py-2 pl-4 pr-3 text-sm text-zinc-300"
        >
          <Markdown text={quote.join("\n")} />
        </blockquote>
      );
      i = j - 1;
      continue;
    }

    // horizontal rules
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList(`list-hr-${i}`);
      blocks.push(<hr key={`hr-${i}`} className="my-4 border-zinc-800" />);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList(`list-h-${i}`);
      const level = heading[1].length;
      const cls = HEADING_SIZES[level] ?? "mt-3 mb-1.5 text-base font-semibold";
      blocks.push(
        <p key={`h-${i}`} className={cls}>
          {renderInline(heading[2], `h-${i}`)}
        </p>
      );
      continue;
    }

    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList(`list-swap-${i}`);
        list = { ordered, items: [] };
      }
      list.items.push((ul?.[1] ?? ol?.[2]) ?? "");
      continue;
    }

    flushList(`list-p-${i}`);
    if (line.trim()) {
      blocks.push(
        <p key={`p-${i}`} className="my-1.5 leading-relaxed">
          {renderInline(line, `p-${i}`)}
        </p>
      );
    }
  }
  flushList("list-end");
  if (code) {
    blocks.push(
      <pre key="code-end" className="my-3 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-sm">
        <code>{code.join("\n")}</code>
      </pre>
    );
  }

  return <div>{blocks}</div>;
}

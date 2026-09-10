export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AiOpts {
  temperature?: number;
  maxTokens?: number;
}

const BASE_URL = process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.NVIDIA_NIM_MODEL || "meta/llama-3.3-70b-instruct";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (!RETRYABLE_STATUS.has(res.status)) {
        const text = await res.text();
        throw new Error(`NVIDIA NIM error ${res.status}: ${text.slice(0, 400)}`);
      }
      lastError = new Error(
        `NVIDIA NIM error ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("NVIDIA NIM error") && !RETRYABLE_STATUS.has(Number(err.message.match(/\d+/)?.[0]))) {
        throw err;
      }
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NVIDIA NIM request failed");
}

function headers(): Record<string, string> {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!key) {
    throw new Error("NVIDIA_NIM_API_KEY is not set. Copy .env.example to .env and add your key from https://build.nvidia.com");
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function body(messages: AiMessage[], opts: AiOpts, stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
    top_p: 0.9,
    max_tokens: opts.maxTokens ?? 2048,
    stream,
  });
}

export async function aiComplete(messages: AiMessage[], opts: AiOpts = {}): Promise<string> {
  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, opts, false),
  });
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function* aiStream(messages: AiMessage[], opts: AiOpts = {}): AsyncGenerator<string> {
  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { ...headers(), Accept: "text/event-stream" },
    body: body(messages, opts, true),
  });
  if (!res.body) {
    throw new Error(`NVIDIA NIM error ${res.status}: empty stream body`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const token = json.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}

function parseSafely(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function topLevelBlocks(s: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{" || c === "[") {
      const start = i;
      const open = c;
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      i = start;
      while (i < s.length) {
        const ch = s[i];
        if (inString) {
          if (ch === "\\") i++;
          else if (ch === '"') inString = false;
        } else {
          if (ch === '"') inString = true;
          else if (ch === open) depth++;
          else if (ch === close && --depth === 0) {
            blocks.push(s.slice(start, i + 1));
            i++;
            break;
          }
        }
        i++;
      }
      if (depth !== 0) {
        blocks.push(s.slice(start));
        break;
      }
      continue;
    }
    i++;
  }
  return blocks;
}

function repairTruncated(block: string): unknown {
  if (!block.length) return undefined;
  let out = block;

  // drop any trailing unclosed string (restores the opening quote as cut point)
  let inString = false;
  let quoteStart = -1;
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') {
        inString = false;
        quoteStart = -1;
      }
    } else if (ch === '"') {
      inString = true;
      quoteStart = i;
    }
    i++;
  }
  if (inString && quoteStart >= 0) {
    out = out.slice(0, quoteStart);
    const tail = out.trimEnd();
    const last = tail[tail.length - 1];
    if (last === ",") {
      out = out.slice(0, out.lastIndexOf(",")).trimEnd() + " null";
    } else if (last === ":") {
      out = out + " null";
    }
  }

  out = out.replace(/,\s*$/, "");
  if (/:\s*$/.test(out)) out = out.trimEnd() + " null";

  // close any unclosed brackets
  const stack: string[] = [];
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inString) {
      if (ch === "\\") j++;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    out += stack[k] === "{" ? "}" : "]";
  }
  return parseSafely(out);
}

export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const direct = parseSafely(s);
  if (direct !== undefined) return direct as T;

  const blocks = topLevelBlocks(s);
  for (const block of blocks) {
    const parsed = parseSafely(block);
    if (parsed !== undefined) return parsed as T;
  }
  for (const block of blocks) {
    const repaired = repairTruncated(block);
    if (repaired !== undefined) return repaired as T;
  }
  throw new Error("Model returned malformed JSON — please try again.");
}

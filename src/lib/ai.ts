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
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, opts, false),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NVIDIA NIM error ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function* aiStream(messages: AiMessage[], opts: AiOpts = {}): AsyncGenerator<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { ...headers(), Accept: "text/event-stream" },
    body: body(messages, opts, true),
  });
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : res.statusText;
    throw new Error(`NVIDIA NIM error ${res.status}: ${text.slice(0, 400)}`);
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

function findJsonSlice(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("Model returned no JSON");
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (end < start) throw new Error("Model returned truncated JSON");
  return s.slice(start, end + 1);
}

export function extractJson<T>(raw: string): T {
  return JSON.parse(findJsonSlice(raw)) as T;
}

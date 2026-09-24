import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keeps the images a conversation sends under the providers' request size
// limits (Anthropic rejects a request over 32 MB, Gemini's inline limit is
// 20 MB). Every image the agent reads (a slide render, a screenshot) stays
// in the history and goes out again with each request. Providers count an
// image as ~1,600 tokens whatever its size, so the context meter stays low
// while the bytes pass the limit and every request fails ("request too
// large").
//
// Before each request, the oldest images are replaced by a line that names
// them, and nothing else changes. The session file keeps every image; only
// what is sent changes. When the images kept pass HIGH, the oldest go until
// LOW remains. The two marks make the set of replaced images change rarely:
// the conversation's start stays the same from request to request, so the
// provider's prompt cache keeps working. The rule depends only on the
// images in order, so the same history always gives the same request.
// Loaded by Chattering for web sessions (-e …/extensions/image-budget.ts).

export const HIGH_BYTES = 16 * 1024 * 1024; // base64 characters, as sent
export const LOW_BYTES = 8 * 1024 * 1024;

type Block = { type?: string; data?: unknown; mimeType?: string; [k: string]: unknown };
type Message = { role?: string; content?: unknown; toolCallId?: string; [k: string]: unknown };

function omittedNote(role: string | undefined, where: string | null): string {
  if (role === "toolResult") {
    return `[An image${where ? ` read from ${where}` : ""} was shown here earlier. It is no longer sent, to keep requests under the provider's size limit.${where ? " Read the file again if you need to see it." : ""}]`;
  }
  return "[An image attached here earlier is no longer sent, to keep requests under the provider's size limit. Ask for it again if you need to see it.]";
}

// The messages to send, or null when every image fits.
export function budgetImages(messages: Message[], { high = HIGH_BYTES, low = LOW_BYTES } = {}):
  { messages: Message[]; dropped: number; droppedBytes: number; keptBytes: number } | null {
  const images: { mi: number; bi: number; size: number }[] = [];
  messages.forEach((m, mi) => {
    if (!Array.isArray(m?.content)) return;
    (m.content as Block[]).forEach((b, bi) => {
      if (b && b.type === "image" && typeof b.data === "string") images.push({ mi, bi, size: b.data.length });
    });
  });
  // Walk oldest to newest. Past HIGH, drop the oldest until LOW remains;
  // the image just added always stays.
  let kept = 0, start = 0;
  for (let i = 0; i < images.length; i++) {
    kept += images[i].size;
    if (kept > high) while (kept > low && start < i) kept -= images[start++].size;
  }
  if (!start) return null;
  const drop = new Set(images.slice(0, start).map(x => x.mi + ":" + x.bi));
  // Which file each tool result showed: the path in its tool call.
  const paths = new Map<string, string>();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      const args = b && b.type === "toolCall" ? (b.arguments as Record<string, unknown> | undefined) : undefined;
      const p = args && (args.path ?? args.file_path);
      if (typeof b?.id === "string" && typeof p === "string") paths.set(b.id, p);
    }
  }
  const out = messages.map((m, mi) => {
    if (!Array.isArray(m?.content) || !(m.content as Block[]).some((_, bi) => drop.has(mi + ":" + bi))) return m;
    const where = m.role === "toolResult" && m.toolCallId ? paths.get(m.toolCallId) ?? null : null;
    return { ...m, content: (m.content as Block[]).map((b, bi) => drop.has(mi + ":" + bi) ? { type: "text", text: omittedNote(m.role, where) } : b) };
  });
  const droppedBytes = images.slice(0, start).reduce((n, x) => n + x.size, 0);
  return { messages: out, dropped: start, droppedBytes, keptBytes: kept };
}

export default function imageBudget(pi: ExtensionAPI) {
  pi.on("context", async event => {
    const result = budgetImages(event.messages as unknown as Message[]);
    return result ? { messages: result.messages as unknown as typeof event.messages } : undefined;
  });
}

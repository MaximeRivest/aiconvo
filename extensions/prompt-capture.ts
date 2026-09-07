import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Captures the system prompt at two points:
//   pending: the fully assembled prompt handed to extensions before a turn
//            (as this extension sees it; extensions loaded after it can still change it)
//   wire:    the system text inside the actual provider payload of the last request
// /sysprompt shows the wire copy; /sysprompt pending, /sysprompt diff for the rest.
// Each capture also lands in ~/.pi/agent/cache/sysprompt/<session>-{pending,wire}.md.

type Capture = { at: string; text: string; model?: string };

function cacheDir() { return join(process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"), "cache", "sysprompt"); }

// Provider payloads differ. Pull the system text from the known shapes.
function systemFromPayload(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const blocks = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((b: any) => typeof b === "string" ? b : b?.text ?? "").filter(Boolean).join("\n\n");
    return undefined;
  };
  if (payload.system !== undefined) return blocks(payload.system);                       // Anthropic
  if (typeof payload.instructions === "string") return payload.instructions;               // OpenAI responses
  if (payload.systemInstruction?.parts) return blocks(payload.systemInstruction.parts);    // Google
  if (Array.isArray(payload.messages)) {                                                   // OpenAI chat and compatibles
    const sys = payload.messages.filter((m: any) => m?.role === "system" || m?.role === "developer");
    if (sys.length) return sys.map((m: any) => blocks(m.content)).filter(Boolean).join("\n\n");
  }
  if (Array.isArray(payload.contents) && payload.system_instruction) return blocks(payload.system_instruction.parts);
  return undefined;
}

function lineDiff(a: string, b: string): string {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push("  " + x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push("- " + x[i++]);
    else out.push("+ " + y[j++]);
  }
  while (i < n) out.push("- " + x[i++]);
  while (j < m) out.push("+ " + y[j++]);
  return out.join("\n");
}

export default function promptCapture(pi: ExtensionAPI) {
  let pending: Capture | undefined;
  let wire: Capture | undefined;
  let sessionKey = "session";

  function save(kind: "pending" | "wire", capture: Capture) {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(join(cacheDir(), `${sessionKey}-${kind}.md`), `<!-- ${kind} ${capture.at} ${capture.model ?? ""} -->\n${capture.text}\n`, "utf8");
    } catch {}
  }

  pi.on("session_start", async (_event, ctx) => {
    pending = wire = undefined;
    sessionKey = ctx.sessionManager.getSessionId?.() || "session";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    pending = { at: new Date().toISOString(), text: event.systemPrompt, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined };
    save("pending", pending);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const text = systemFromPayload(event.payload);
    if (text === undefined) return;
    wire = { at: new Date().toISOString(), text, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined };
    save("wire", wire);
  });

  pi.registerCommand("sysprompt", {
    description: "Show the system prompt: last one sent on the wire (default), pending, or diff",
    getArgumentCompletions: () => [{ value: "wire", label: "last sent to the provider" }, { value: "pending", label: "as assembled before the last turn" }, { value: "diff", label: "pending vs wire" }],
    handler: async (args, ctx) => {
      const which = args.trim().toLowerCase() || "wire";
      const header = (kind: string, c: Capture) => `# ${kind} system prompt — ${c.at} — ${c.model ?? "unknown model"} — ${c.text.length} chars\n\n`;
      let body: string;
      if (which === "pending") {
        if (!pending) { ctx.ui.notify("No turn has started yet in this session.", "warning"); return; }
        body = header("pending", pending) + pending.text;
      } else if (which === "diff") {
        if (!pending || !wire) { ctx.ui.notify("Need one full turn first (pending and wire captures).", "warning"); return; }
        body = pending.text === wire.text ? "pending and wire system prompts are identical" : `# pending (-) vs wire (+)\n\n${lineDiff(pending.text, wire.text)}`;
      } else {
        if (!wire) { ctx.ui.notify("No provider request has been sent yet in this session.", "warning"); return; }
        body = header("wire", wire) + wire.text;
      }
      if (ctx.hasUI) await ctx.ui.editor("System prompt (read-only view, Esc to close)", body);
      else console.log(body);
      ctx.ui.notify(`Files: ${join(cacheDir(), sessionKey + "-{pending,wire}.md")}`, "info");
    },
  });
}

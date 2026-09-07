import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Records tools: let the agent mine every aiconvo conversation, note, project
// memory, epic and evidence card. Each tool is a thin call to the local
// server's GET /api/records/<op>; the text that comes back is the same text
// the `aiconvo` CLI prints, so a bash user and a tool user read one format.
//
// Load with -e /absolute/path/extensions/records.ts (aiconvo does this for
// web sessions and delegated workers). Terminal: pi -e …/records.ts.

// Read at call time: the env decides which server answers, and tests move it.
const port = () => Number(process.env.AICONVO_PORT || process.env.PORT || 7433);
const token = () => process.env.AICONVO_TOKEN || "";
const TRUTH = "Records are AI transcripts and AI-written notes: a map of what was said, not verified truth. [unverified] marks notes no person reviewed.";

async function call(op: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const PORT = port(), TOKEN = token();
  const headers: Record<string, string> = TOKEN ? { Authorization: "Bearer " + TOKEN } : {};
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/api/records/${op}?${qs}`, { headers, signal });
  } catch (e: any) {
    throw new Error(`aiconvo server is not answering on port ${PORT} (${e?.cause?.code || e?.message}). Start it: systemctl --user start aiconvo`);
  }
  const data: any = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || data.text || `HTTP ${res.status}`);
  const text = String(data.text || "");
  const { text: _t, ...details } = data;
  return { content: [{ type: "text" as const, text }], details };
}

// The conversation's own session file: its hits are dropped from search so
// an agent never "finds" what it just said.
function selfPath(ctx: any): string | undefined {
  try { return ctx?.sessionManager?.getSessionFile?.() || undefined; } catch { return undefined; }
}

export default function records(pi: ExtensionAPI) {
  pi.registerTool({
    name: "aiconvo_search", label: "aiconvo search",
    description: "Search every past conversation, distilled note, project memory document and epic across all projects (lexical, plus semantic when available). Returns ranked passages with a short conversation id, date, project and the follow-up command. Use it before asking the user what was decided, tried, or why. " + TRUTH,
    promptSnippet: "Search past conversations, notes and project memory across all projects",
    promptGuidelines: [
      "Before you ask the user what was decided, tried, or why, run aiconvo_search; then zoom with aiconvo_show. Quote the conversation id and date when you use what you found.",
      "Treat records as what was said, not verified truth. Prefer [vouched] notes over [unverified] ones, and the transcript over both when it matters.",
    ],
    parameters: Type.Object({
      q: Type.String({ description: "Words to find. All words must match; \"quoted phrase\" matches exactly. Operators: project: role: type: after: before: path:" }),
      project: Type.Optional(Type.String({ description: "Only this project (default: all projects, current project ranked first)" })),
      since: Type.Optional(Type.String({ description: "30d, 2w, 6m, 1y or a date" })),
      role: Type.Optional(StringEnum(["user", "assistant", "tool", "toolresult", "thinking"] as const)),
      type: Type.Optional(StringEnum(["conversation", "note", "epic", "memory"] as const)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Records per page (default 10)" })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      semantic: Type.Optional(Type.Boolean({ description: "Add paraphrase hits from the semantic stage (default true when available)" })),
      max: Type.Optional(Type.Integer({ minimum: 500, description: "Output character cap (default 9000)" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      return call("search", { ...params, dir: ctx.cwd, excludePath: selfPath(ctx) }, signal);
    },
  });

  pi.registerTool({
    name: "aiconvo_show", label: "aiconvo show",
    description: "Read one past conversation by its short id (from aiconvo_search or aiconvo_list), full key, or session file path. With no position: header plus an outline of every user turn. With at: the messages around #N, all roles. With from/to: a range. With last: the tail. Output is bounded and ends with the next command.",
    promptSnippet: "Read one past conversation: outline, a slice around a message, or the tail",
    parameters: Type.Object({
      id: Type.String(),
      at: Type.Optional(Type.Integer({ minimum: 0, description: "Center message index; shows tools and thinking too" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Messages on each side of at (default 3)" })),
      from: Type.Optional(Type.Integer({ minimum: 0 })),
      to: Type.Optional(Type.Integer({ minimum: 0 })),
      last: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Last N user/assistant messages" })),
      roles: Type.Optional(StringEnum(["chat", "all"] as const)),
      max: Type.Optional(Type.Integer({ minimum: 500, description: "Output character cap (default 12000)" })),
    }),
    async execute(_id, params, signal) { return call("show", params, signal); },
  });

  pi.registerTool({
    name: "aiconvo_memory", label: "aiconvo memory",
    description: "Read the AI-written memory map of a project (overview, intent, environment, status), of one declared area of a project, or of an epic. Each document carries a trust label. Default project: the one of the current folder.",
    promptSnippet: "Read a project's, area's or epic's memory documents (overview, intent, environment, status)",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      area: Type.Optional(Type.String({ description: "Declared area path inside the project" })),
      epic: Type.Optional(Type.String({ description: "Epic id; replaces project" })),
      kind: Type.Optional(StringEnum(["overview", "intent", "environment", "status"] as const)),
      max: Type.Optional(Type.Integer({ minimum: 500 })),
    }),
    async execute(_id, params, signal, _update, ctx) { return call("memory", { ...params, dir: ctx.cwd }, signal); },
  });

  pi.registerTool({
    name: "aiconvo_read", label: "aiconvo read",
    description: "Read one record: the distilled note of a conversation (or a note file under the notes tree), an epic narrative, or the evidence card of a conversation. Trust labels are printed. " + TRUTH,
    promptSnippet: "Read a distilled note, an epic, or a conversation's evidence card",
    parameters: Type.Object({
      what: StringEnum(["note", "epic", "evidence"] as const),
      id: Type.String({ description: "Conversation short id, epic id, or note file path" }),
      max: Type.Optional(Type.Integer({ minimum: 500 })),
    }),
    async execute(_id, params, signal) { return call(params.what, { id: params.id, max: params.max }, signal); },
  });

  pi.registerTool({
    name: "aiconvo_list", label: "aiconvo list",
    description: "List what is on record: projects (with memory state), conversations of a project (newest first), distilled notes, or epics. Default project: the one of the current folder; set project to 'all' for everything.",
    promptSnippet: "List projects, a project's conversations, notes, or epics",
    parameters: Type.Object({
      what: StringEnum(["projects", "conversations", "notes", "epics"] as const),
      project: Type.Optional(Type.String({ description: "Project name, or 'all'" })),
      since: Type.Optional(Type.String({ description: "conversations only: 30d, 2w, or a date" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
      max: Type.Optional(Type.Integer({ minimum: 500 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const all = params.project === "all";
      const p: Record<string, unknown> = { since: params.since, limit: params.limit, max: params.max };
      if (!all) { p.project = params.project; p.dir = ctx.cwd; }
      return call(params.what, p, signal);
    },
  });
}

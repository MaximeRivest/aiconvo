// aiconvo bridge extension for pi.
//
// Loaded by aiconvo's per-operation RPC worker:
//   pi --mode rpc --no-extensions -e aiconvo-bridge.ts --session <file>
//
// It exposes pi's own runtime operations that plain RPC commands do not reach.
// Today that is one command:
//
//   /aiconvo-fork-at <entryId>
//     Fork the active session THROUGH the given entry (position "at"):
//     the new session keeps the entry itself. Plain RPC `fork` only supports
//     "before" semantics on user messages. pi's runtime writes the new file
//     (SessionManager.createBranchedSession), so aiconvo copies no internals.
//
// Contract with the client (server.js piForkAt):
//   - The client verifies this command exists via `get_commands` BEFORE
//     sending it. An unregistered command would go to the model as a prompt.
//   - Success is observed via `get_state`: sessionFile changes to the fork.
//   - Failures surface as `extension_error` events and stderr text.
//
// No imports: the file must load in any pi extension loader environment.

export default function (pi: any) {
  pi.registerCommand("aiconvo-fork-at", {
    description: "aiconvo: fork the session through an entry (position 'at')",
    handler: async (args: string, ctx: any) => {
      const entryId = String(args || "").trim();
      if (!entryId) throw new Error("aiconvo-fork-at: missing entry id");
      const result = await ctx.fork(entryId, { position: "at" });
      if (result.cancelled) throw new Error("aiconvo-fork-at: fork was cancelled");
    },
  });
}

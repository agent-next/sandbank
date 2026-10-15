import { library } from './catalog.js'

export { library, callTool, handleToolResponse } from './catalog.js'

export const RENDER_VIEW_EXAMPLE = `root = Stack([card])
card = Card("Build result", [Stack([s1, s2], "row"), out, tbl, btn])
s1 = Stat("Exit code", 0, "good")
s2 = Stat("Duration ms", 1240)
out = LogBlock("compiled 12 files", "", 0)
tbl = Table(["file", "size"], [["a.ts", 120], ["b.ts", 340]])
btn = ActionButton("Re-run", "sandbox_exec", {provider: "docker", id: "sb-1", command: "make"})`

/** System-prompt text describing the OpenUI Lang catalog; meant for the `render_view` tool description. */
export function getCatalogPrompt(): string {
  return library.prompt({
    preamble:
      'Compose a result view for the user as an OpenUI Lang program. Pass the program in the `openui` argument of render_view.',
    additionalRules: [
      'The root statement must be `root = Stack([...])`.',
      'Use ActionButton only with real tools of this MCP server and complete arguments.',
    ],
    examples: [RENDER_VIEW_EXAMPLE],
  })
}

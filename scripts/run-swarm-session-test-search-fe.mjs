// scripts/run-swarm-session-test-search-fe.mjs — main-agent-driven session test,
// search-frontend task. Prompts the main agent with a natural job; the agent
// spawns subagents itself and summarizes. Shares all scaffolding with the toy
// variant via _run-session-test.mjs.
//
//   node scripts/run-swarm-session-test-search-fe.mjs [round]

import { runSessionTest } from "./_run-session-test.mjs";

const PROMPT = `Build a multi-modal search API from scratch in this dedicated test workspace.

Workspace: "{WORKSPACE_DIR}" (it starts empty and is isolated from other tests). Write every file NEW — do NOT reuse, copy, or adopt any existing code or file as your product, and do NOT read files from any other workspace.

Spawn 4 subagents to build it in parallel:
1. One builds the search frontend.
2. One builds the embedding backend.
3. One designs the API schema.
4. One writes smoke tests.

When all 4 subagents have finished, write a one-paragraph summary of what was built.`;

runSessionTest(PROMPT, process.argv[2] ?? "005", "search-fe").catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});

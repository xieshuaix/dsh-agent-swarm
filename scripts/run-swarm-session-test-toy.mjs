// scripts/run-swarm-session-test-toy.mjs — main-agent-driven session test, toy
// task. Same scaffolding as the search-fe variant; only the task differs (a
// tiny ~1-minute toy app, and each subagent is told to write its own quick plan
// first).
//
//   node scripts/run-swarm-session-test-toy.mjs [round]

import { runSessionTest } from "./_run-session-test.mjs";

const PROMPT = `Build a tiny "click counter" web app in this workspace. Keep it minimal — it should take about a minute.

Spawn 4 subagents in parallel. In each subagent's instructions, ask it to first write a quick 2-3 step plan for itself, then do its part:
1. One writes index.html
2. One writes style.css
3. One writes app.js
4. One writes README.md

When all 4 subagents have finished, write a one-paragraph summary of what was built.`;

runSessionTest(PROMPT, process.argv[2] ?? "006").catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});

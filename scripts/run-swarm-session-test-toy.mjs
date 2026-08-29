// scripts/run-swarm-session-test-toy.mjs — main-agent-driven session test, toy
// task. Same scaffolding as the search-fe variant; only the task differs (a
// tiny ~1-minute toy app, and each subagent is told to write its own quick plan
// first).
//
//   node scripts/run-swarm-session-test-toy.mjs [round]

import { runSessionTest } from "./_run-session-test.mjs";

const PROMPT = `Build a tiny "click counter" web app in this workspace. Keep it minimal — it should take about a minute.

Use the swarm tool to recruit 4 subagents, each with model deepseek-v4-flash and reasoningEffort off. Have each subagent write a quick 2-3 step plan first, then do its part:
1. One writes index.html
2. One writes style.css
3. One writes app.js
4. One writes README.md

After recruiting, set the plan, confirm execution, and when they finish, record a one-paragraph summary with the swarm tool.`;

runSessionTest(PROMPT, process.argv[2] ?? "006").catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});

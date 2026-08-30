// scripts/run-swarm-session-test-scale.mjs — main-agent-driven session test for
// LARGE swarms: 20 subagents at concurrency 5, each doing a small ~1-2 minute
// task (write one CSS theme file) so the plugin is exercised at scale. Everything
// other than the problem, the number of agents, and the concurrency mirrors the
// toy test: AGENTS.md, per-agent rolePrompt, outlinePlan, one artifact each,
// plan → confirm → summarize.
//
//   node scripts/run-swarm-session-test-scale.mjs [round]

import { runSessionTest } from "./_run-session-test.mjs";

const THEMES = [
  ["01", "ocean"], ["02", "sunset"], ["03", "forest"], ["04", "candy"],
  ["05", "midnight"], ["06", "citrus"], ["07", "rose"], ["08", "mint"],
  ["09", "lavender"], ["10", "amber"], ["11", "teal"], ["12", "coral"],
  ["13", "slate"], ["14", "gold"], ["15", "berry"], ["16", "sky"],
  ["17", "lime"], ["18", "peach"], ["19", "indigo"], ["20", "maroon"],
];

const THEME_LINES = THEMES.map(([n, slug]) => `${Number(n)}. ${slug} — themes/${n}-${slug}.css`).join("\n");

const PROMPT = `Build a "Web Color Themes" reference library from scratch in this dedicated test workspace.

Workspace: "{WORKSPACE_DIR}" (it starts empty and is isolated from other tests). Write every file NEW — do NOT reuse, copy, or adopt any existing code or file as your product, and do NOT read files from any other workspace. Each theme file should be small (~20-30 lines) and take about 1-2 minutes.

First write an AGENTS.md file defining the shared role in one line (each subagent is a "theme designer" that writes one CSS color-theme file into the themes/ directory).

Then use the swarm tool to recruit 20 subagents with concurrency 5, each with model deepseek-v4-flash and reasoningEffort off. Give each subagent a rolePrompt that states its role (e.g. "You are the ocean palette designer."), and have each write a quick 2-3 step plan first, then do its part. IMPORTANT: each subagent must WRITE its file from scratch (overwrite any existing file with that name) — never skip writing because a file already exists, so every role produces a fresh artifact. Each file is a 5-color CSS palette (background, surface, text, primary, accent) plus demo .card and button styles for its theme.

The 20 themes (one subagent each):
${THEME_LINES}

After recruiting, set the plan, confirm execution, and when they finish, record a one-paragraph summary with the swarm tool.`;

runSessionTest(PROMPT, process.argv[2] ?? "001", "scale").catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});

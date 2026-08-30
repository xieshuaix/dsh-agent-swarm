// scripts/_run-session-test.mjs — shared runner for the main-agent-driven
// session tests. Creates a fresh grouped session, prompts the main agent with a
// natural task (no command recipe), then only OBSERVES /swarm/state until the
// swarm is complete and a summary is recorded.
//
// The two thin entrypoints (run-swarm-session-test-search-fe.mjs and
// run-swarm-session-test-toy.mjs) differ ONLY in the task prompt + default
// round + test name; everything else is this shared runner.
//
// Test workspaces are isolated per test under a directory that is anchored to
// THIS plugin (so the checkout can live anywhere):
//
//   <parent-of-plugin>/dsh-agent-swarm-tests/<test_name>/
//
// The path is programmatically determined, injected into the prompt as the
// `{WORKSPACE_DIR}` placeholder, and the directory is guaranteed not to exist
// before the run (wiped + recreated fresh).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");
// Sibling of the plugin dir, e.g. ~/Documents/DeepSeek/dsh-agent-swarm-tests.
const TESTS_ROOT = process.env.DSH_SWARM_TESTS_DIR ?? join(dirname(PLUGIN_DIR), "dsh-agent-swarm-tests");

const HOST = process.env.DSH_HOME_URL ?? "http://127.0.0.1:3080";

async function unary(method, payload = {}, rpc = "r") {
  const res = await fetch(`${HOST}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: rpc, method, payload }),
  });
  const body = await res.json();
  if (body?.type === "server-response" && body.result) return body.result;
  throw new Error(`${method} failed: ${JSON.stringify(body)}`);
}

async function swarmGet(sessionId) {
  const res = await fetch(`${HOST}/swarm/state?session=${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} prompt     the natural task sent to the main agent (may contain `{WORKSPACE_DIR}`)
 * @param {string} round      experiment round number ("005")
 * @param {string} testName   stable test slug, e.g. "toy" → workspace `dsh-agent-swarm-tests/toy-005`
 */
export async function runSessionTest(prompt, round, testName = "experiment") {
  const n = String(Number.parseInt(round, 10) || 5).padStart(3, "0");
  const title = `swarm experiment ${n}`;
  const testDirName = `${testName}-${n}`;
  const wsPath = join(TESTS_ROOT, testDirName);

  // Guarantee the test directory does not already exist — every run starts from
  // an empty filesystem (no AGENTS.md, no app files) so artifacts can't leak
  // between tests.
  if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });
  mkdirSync(wsPath, { recursive: true });

  const createdWs = await unary("workspace.create", { path: wsPath });
  let workspace = createdWs.value.workspace;
  // workspace.create titles the workspace by its basename only ("toy-019");
  // retitle it to reflect the folder structure relative to the tests root's
  // parent ("dsh-agent-swarm-tests/toy-019") so the sidebar matches the layout.
  const displayTitle = `${basename(TESTS_ROOT)}/${testDirName}`;
  if (workspace.title !== displayTitle) {
    const renamed = await unary("workspace.rename", { workspaceId: workspace.workspaceId, title: displayTitle });
    workspace = renamed.value.workspace;
  }
  const created = await unary("session.create", { workspaceId: workspace.workspaceId });
  const sessionId = created.value.sessionId;
  await unary("session.rename", { sessionId, title });
  console.log(`session: ${title} (${sessionId}) in workspace "${workspace.title}" (${wsPath})`);

  // Programmatically inject the exact workspace path into the prompt.
  const finalPrompt = String(prompt).replaceAll("{WORKSPACE_DIR}", wsPath);
  const promptResult = await unary("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: finalPrompt }],
  });
  console.log(`main agent prompted: ${JSON.stringify(promptResult)}`);

  // Observe only — do not mutate swarm state.
  const deadline = Date.now() + 15 * 60 * 1000;
  let snapshot;
  for (;;) {
    await sleep(5000);
    snapshot = (await swarmGet(sessionId)).swarm;
    const terminal = snapshot.agents.length > 0 && snapshot.agents.every((a) => a.status === "complete" || a.status === "error");
    const hasSummary = typeof snapshot.summary === "string" && snapshot.summary !== "";
    process.stdout.write(`\r  phase=${snapshot.phase} agents=${snapshot.agents.length} complete=${snapshot.completedCount} summary=${hasSummary ? "yes" : "no"}   `);
    if (terminal && hasSummary) break;
    if (Date.now() > deadline) break;
  }
  console.log("");

  console.log(`\nphase=${snapshot.phase} objective="${snapshot.objective}"`);
  console.log(`summary="${snapshot.summary ?? "(none)"}"`);
  for (const a of snapshot.agents) {
    console.log(
      `- ${a.name} [${a.role}] ${a.status} ${a.progress}%` +
      ` plan=${a.plan?.length ?? 0} todos=${a.todos?.length ?? 0} logs=${a.logs?.length ?? 0} artifacts=${a.artifacts?.length ?? 0}` +
      ` model=${a.model ?? "?"} effort=${a.reasoningEffort ?? "?"}`
    );
  }
  // At-a-glance check: how many agents produced their own plan and ≥1 artifact.
  const withPlan = snapshot.agents.filter((a) => (a.plan?.length ?? 0) > 0).length;
  const withArtifact = snapshot.agents.filter((a) => (a.artifacts?.length ?? 0) > 0).length;
  console.log(`\nagents with own plan: ${withPlan}/${snapshot.agents.length}; agents with >=1 artifact: ${withArtifact}/${snapshot.agents.length}`);
  console.log(`session: ${sessionId}`);
}

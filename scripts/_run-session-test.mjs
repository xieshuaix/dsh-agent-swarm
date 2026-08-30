// scripts/_run-session-test.mjs — shared runner for the main-agent-driven
// session tests. Creates a fresh grouped session, prompts the main agent with a
// natural task (no command recipe), then only OBSERVES /swarm/state until the
// swarm is complete and a summary is recorded.
//
// The two thin entrypoints (run-swarm-session-test-search-fe.mjs and
// run-swarm-session-test-toy.mjs) differ ONLY in the task prompt + default
// round; everything else is this shared runner.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const HOST = process.env.DSH_HOME_URL ?? "http://127.0.0.1:3080";
// Dedicated, disposable test workspace — separate from the real "Swarm
// Experiments" workspace so toy runs never touch real work, and wiped fresh on
// every round so artifacts from a previous test can't leak into the next.
const WORKSPACE = process.env.WORKSPACE ?? "Swarm Tests";

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
 * @param {string} prompt  the natural task sent to the main agent
 * @param {string} round   experiment round number ("005")
 */
export async function runSessionTest(prompt, round) {
  const n = String(Number.parseInt(round, 10) || 5).padStart(3, "0");
  const title = `swarm experiment ${n}`;

  // Wipe + recreate the dedicated workspace directory so this round starts from
  // an empty filesystem (no AGENTS.md, no app files) — isolation between tests.
  const wsPath = join(process.env.HOME, "Documents", "DeepSeek", WORKSPACE.toLowerCase().replace(/\s+/g, "-"));
  if (existsSync(wsPath)) rmSync(wsPath, { recursive: true, force: true });
  mkdirSync(wsPath, { recursive: true });
  const createdWs = await unary("workspace.create", { path: wsPath });
  const workspace = createdWs.value.workspace;
  const created = await unary("session.create", { workspaceId: workspace.workspaceId });
  const sessionId = created.value.sessionId;
  await unary("session.rename", { sessionId, title });
  console.log(`session: ${title} (${sessionId}) in workspace "${workspace.title}" (${wsPath})`);

  const promptResult = await unary("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: prompt }],
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
  console.log(`\nsession: ${sessionId}`);
}

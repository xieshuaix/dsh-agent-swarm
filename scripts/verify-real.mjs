// scripts/verify-real.mjs — verify the plugin's full data projection against a
// REAL completed swarm round, without the running host.
//
// Mounts the real host half (lib/index.js apply) with a fake Cordis ctx whose
// `sessions.get` reads the real child-session JSONL (decompressed via zstd) and
// whose `agents.get` supplies the workspace cwd. The swarm store is the real
// `$DSH_HOME/agent-swarm/<session>.json`. This exercises the exact code path the
// host runs — readChildTodos / readChildLogs / readChildPlan / listArtifacts
// (marker fallback) / derivation — against the evidence a real round produced.
//
//   node scripts/verify-real.mjs [sessionId]
//
//   DSH_HOME   — harness home (default ~/.dsh)
//   CWD        — workspace cwd (default /Users/xs/Documents/DeepSeek/swarm-experiments)

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { createFakeCtx } from "../test/helpers/fake-ctx.mjs";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const CWD = process.env.CWD ?? "/Users/xs/Documents/DeepSeek/swarm-experiments";
const SESSION_ID = process.argv[2] ?? "session-89085ef6-f468-4300-b28a-54324454a4a9";

const storeFile = join(DSH_HOME, "agent-swarm", `${SESSION_ID}.json`);
const store = JSON.parse(readFileSync(storeFile, "utf8"));
const childIds = store.agents.map((a) => a.childId).filter(Boolean);

function findChildDir(childId) {
  const base = join(DSH_HOME, "sessions");
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name, childId);
    try {
      if (readdirSync(candidate).length > 0) return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function readChildEvents(childId) {
  const dir = findChildDir(childId);
  if (dir === null) return [];
  const file = join(dir, "session.jsonl.zstd");
  const zstd = spawnSync("zstd", ["-dc", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const events = [];
  for (const line of (zstd.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip partial */ }
  }
  return events;
}

const sessions = {
  get: (id) => {
    if (childIds.includes(id)) return { id, events: readChildEvents(id) };
    if (id === SESSION_ID) return { id: SESSION_ID, header: { cwd: CWD }, events: [] };
    return undefined;
  },
  list: () => []
};
const agents = {
  get: (id) => (id ? { id, session: { id, header: { cwd: CWD } }, options: {} } : undefined),
  list: () => []
};

const fake = createFakeCtx({ sessions, agents });
apply(fake.ctx, {});
const projection = fake.provided.swarm.state({ id: SESSION_ID, header: { cwd: CWD } });

console.log(`phase=${projection.phase} objective="${projection.objective}"`);
for (const a of projection.agents) {
  console.log(`\n=== ${a.name} [${a.role}] ${a.status} ${a.progress}% ===`);
  console.log(`  color=${a.color} avatar=${a.avatarId} mode=${a.progressMode} wave=${a.wave} model=${a.model ?? "?"} effort=${a.reasoningEffort ?? "?"}`);
  console.log(`  systemPrompt: ${(a.systemPrompt || "").split("\n")[0].slice(0, 80)}`);
  console.log(`  plan: ${(a.plan || []).map((p) => p.title).join(" | ") || "(none)"}`);
  console.log(`  todos: ${(a.todos || []).map((t) => (t.done ? "✓" : "○") + t.text).join(" | ") || "(none)"}`);
  console.log(`  logs (${(a.logs || []).length}): ${(a.logs || []).slice(0, 4).map((l) => `${l.type}:${String(l.content).slice(0, 30)}`).join(" | ")}`);
  console.log(`  artifacts (${(a.artifacts || []).length}): ${(a.artifacts || []).map((f) => `${f.path}(${f.artifactType})`).join(" | ") || "(none)"}`);
}
console.log(`\nresources: ${(projection.resources || []).map((r) => r.name).join(" | ") || "(none)"}`);
console.log(`lines: ${(projection.lines || []).map((l) => `${l.from}→${l.to}:${l.type}`).join(" | ") || "(none)"}`);

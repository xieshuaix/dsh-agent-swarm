// scripts/migrate-test-workspaces.mjs — migrate the previous swarm-experiment
// workspaces under the new per-test directory tree, so they stay visible in DSH
// after the old directories are removed.
//
// DSH keys every session to its workspace cwd: the session log lives at
//   $DSH_HOME/sessions/<projectKey(cwd)>/<sessionId>/session.jsonl.zstd
// and the workspace registry ($DSH_HOME/storages/workspace.json) stores each
// workspace's path. A migration is therefore three coordinated moves:
//   1. move the workspace FILES directory,
//   2. move the session-log directory to projectKey(newPath),
//   3. rewrite every session log's embedded `cwd` (old → new),
//   4. update workspace.json's path.
//
// Run with DRY=1 to print the plan without touching anything. Afterwards the
// HOST MUST BE RESTARTED (the registry is loaded at boot) before any other
// workspace operation.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");
const TESTS_ROOT = process.env.DSH_SWARM_TESTS_DIR ?? join(dirname(PLUGIN_DIR), "dsh-agent-swarm-tests");
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME, ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const WORKSPACE_JSON = join(DSH_HOME, "storages", "workspace.json");
const DRY = process.env.DRY === "1";

// old workspace path → { name: new dir name under TESTS_ROOT, title: new sidebar title }
const MIGRATIONS = [
  { oldPath: join(dirname(PLUGIN_DIR), "swarm-experiments"), name: "swarm-experiments", title: "Swarm Experiments" },
  { oldPath: join(dirname(PLUGIN_DIR), "swarm-tests"), name: "toy-018", title: "toy-018" },
];

// Mirror of dsh-session-persistence-jsonl `projectKey`: encode a cwd into the
// filesystem-safe project directory name used under $DSH_HOME/sessions.
function projectKey(cwd) {
  if (!cwd) throw new Error("empty cwd");
  let readable = "";
  let separatorRun = false;
  for (const ch of cwd) {
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function rewriteCwd(logPath, oldPath, newPath) {
  const text = execFileSync("zstd", ["-d", "-c", logPath], { encoding: "utf8" });
  if (!text.includes(oldPath)) return false;
  const next = text.split(oldPath).join(newPath);
  if (DRY) return true;
  execFileSync("zstd", ["-q", "-f", "-o", logPath], { input: next });
  return true;
}

function main() {
  const registry = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
  const workspaces = registry.tables?.workspaces ?? {};
  const summary = [];

  for (const { oldPath, name, title } of MIGRATIONS) {
    const newPath = join(TESTS_ROOT, name);
    const entry = Object.values(workspaces).find((w) => w.path === oldPath);
    const oldProj = projectKey(oldPath);
    const newProj = projectKey(newPath);
    const oldSessions = join(SESSIONS_ROOT, oldProj);
    const newSessions = join(SESSIONS_ROOT, newProj);
    const record = { oldPath, newPath, title, workspaceFound: !!entry, filesMoved: false, sessionsMoved: 0, cwdRewritten: 0 };

    // 1. Workspace files directory.
    if (existsSync(oldPath)) {
      if (!DRY) {
        mkdirSync(dirname(newPath), { recursive: true });
        renameSync(oldPath, newPath);
      }
      record.filesMoved = true;
    }

    // 2. Session-log directory.
    let sessionIds = [];
    if (existsSync(oldSessions)) {
      if (!DRY) {
        sessionIds = readdirSync(oldSessions);
        mkdirSync(dirname(newSessions), { recursive: true });
        renameSync(oldSessions, newSessions);
      }
      record.sessionsMoved = sessionIds.length;
    }

    // 3. Rewrite each session log's embedded cwd (old → new).
    if (!DRY && existsSync(newSessions)) {
      for (const sid of readdirSync(newSessions)) {
        const dir = join(newSessions, sid);
        try {
          for (const f of readdirSync(dir)) {
            if (f.startsWith("session") && f.endsWith(".jsonl.zstd")) {
              if (rewriteCwd(join(dir, f), oldPath, newPath)) record.cwdRewritten++;
            }
          }
        } catch { /* skip */ }
      }
    }

    // 4. Update the registry entry in place.
    if (entry) {
      entry.path = newPath;
      if (title) entry.title = title;
      entry.updatedAt = new Date().toISOString();
    }

    summary.push(record);
    console.log(`${DRY ? "[DRY] " : ""}${oldPath} → ${newPath} (workspace=${entry ? "yes" : "MISSING"}, filesMoved=${record.filesMoved}, sessionsMoved=${record.sessionsMoved}, cwdRewritten=${record.cwdRewritten})`);
  }

  if (!DRY) {
    const bak = `${WORKSPACE_JSON}.migrate.bak`;
    writeFileSync(bak, readFileSync(WORKSPACE_JSON));
    writeFileSync(WORKSPACE_JSON, JSON.stringify(registry, null, 2));
    console.log(`\nwrote ${WORKSPACE_JSON} (backup at ${bak})`);
  } else {
    console.log("\n[DRY] no changes written.");
  }

  console.log("\n=== SUMMARY ===");
  for (const r of summary) console.log(`- ${r.title}: ${r.oldPath} → ${r.newPath}${r.workspaceFound ? "" : "  ⚠ workspace not found in registry"}`);
  console.log("\nNEXT: restart the DSH host, then verify `workspace.list` shows the new paths.");
}

main();

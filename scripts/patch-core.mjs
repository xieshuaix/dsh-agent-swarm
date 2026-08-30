#!/usr/bin/env node
// dsh-agent-swarm — one-time core patch: subagent reasoning-effort routing.
//
// The subagent seam's `agentOptions` passes `provider`/`model`/`maxTokens`
// through to a child agent, but `reasoningEffort` is silently dropped: the
// request-builder (`dsh-agent-loop` `buildRequest`) derives the effort only from
// the persisted `request/header`, never from `AgentOptions`. So a plugin can
// route a subagent to a cheap model (`model: "deepseek-v4-flash"`) but cannot
// turn its thinking OFF — the effort falls back to the deployment default
// ("high"), which still spends reasoning tokens.
//
// This script applies one minimal, additive, backward-compatible edit that lets
// `AgentOptions.reasoningEffort` win over the persisted fallback:
//
//   old:  const reasoningEffort = persistedConfig… ? persistedConfig.reasoningEffort : void 0;
//   new:  const reasoningEffort = this.options.reasoningEffort !== void 0
//           ? this.options.reasoningEffort
//           : persistedConfig… ? persistedConfig.reasoningEffort : void 0;
//
// With no `reasoningEffort` in the options (every existing agent), behavior is
// byte-for-byte unchanged. Effort values accepted by the DeepSeek adapter:
// "off" (thinking disabled), "low", "high", "max".
//
// NOT applied automatically on plugin install — run it explicitly.
//
// Usage:
//   node scripts/patch-core.mjs --checkout /path/to/@deepseek-ai/dsh     # apply
//   node scripts/patch-core.mjs --checkout /path/to/@deepseek-ai/dsh --rollback  # undo
// (or set DSH_CHECKOUT). Idempotent: re-running reports "already patched".
// Each patched file gets a `<file>.dsh-agent-swarm.bak` backup; --rollback
// restores it. Apply/un-apply, then restart the host ONCE (the running host
// keeps the modules it already imported).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  console.error(`patch-core: ${message}`);
  process.exit(1);
}

const checkout = process.argv.includes("--checkout")
  ? process.argv[process.argv.indexOf("--checkout") + 1]
  : process.env.DSH_CHECKOUT;

if (checkout === void 0 || checkout === "") {
  fail("no checkout path; pass --checkout <path> or set DSH_CHECKOUT");
}

const rollback = process.argv.includes("--rollback");

const OLD = [
  "\t\tconst reasoningEffort = persistedConfig?.provider === route.provider && persistedConfig.model === route.model && persistedHeader?.adapterDefaults?.reasoningEffort !== true ? persistedConfig.reasoningEffort : void 0;"
].join("\n");

const NEW = [
  "\t\tconst reasoningEffort = this.options.reasoningEffort !== void 0 ? this.options.reasoningEffort : persistedConfig?.provider === route.provider && persistedConfig.model === route.model && persistedHeader?.adapterDefaults?.reasoningEffort !== true ? persistedConfig.reasoningEffort : void 0;"
].join("\n");

const PATCHES = [
  ["@deepseek-ai/dsh-agent-loop", "lib/index.js", OLD, NEW, "this.options.reasoningEffort !== void 0"]
];

let changedCount = 0;
for (const [pkg, rel, oldText, newText, marker] of PATCHES) {
  const file = join(checkout, "node_modules", pkg, rel);
  const bak = `${file}.dsh-agent-swarm.bak`;
  if (!existsSync(file)) fail(`missing file: ${file}`);
  const content = readFileSync(file, "utf8");

  if (rollback) {
    if (!existsSync(bak)) {
      console.log(`no backup for ${pkg}/${rel} — nothing to roll back`);
      continue;
    }
    writeFileSync(file, readFileSync(bak, "utf8"));
    unlinkSync(bak);
    changedCount += 1;
    console.log(`rolled back: ${pkg}/${rel} (restored from backup)`);
    continue;
  }

  if (content.includes(marker)) {
    console.log(`already patched: ${pkg}/${rel}`);
    continue;
  }
  if (!content.includes(oldText)) {
    fail(`target not found in ${file} — this checkout's build differs; patch manually or upgrade the plugin`);
  }
  if (!existsSync(bak)) writeFileSync(bak, content);
  writeFileSync(file, content.replace(oldText, newText));
  changedCount += 1;
  console.log(`patched: ${pkg}/${rel} (backup at ${bak})`);
}

if (rollback) {
  console.log(changedCount === 0 ? "nothing to roll back" : `rolled back ${changedCount} file(s); restart the host to load them`);
} else {
  console.log(changedCount === 0 ? "no changes needed" : `patched ${changedCount} file(s); restart the host to load them`);
}

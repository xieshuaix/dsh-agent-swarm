// scripts/verify-interactions.mjs — drive the LIVE swarm card in the real DSH
// GUI and assert the ideal UI's interactions work end-to-end: agent click →
// detail popup, canvas open, and the tasks/percent progress toggle.
//
//   node scripts/verify-interactions.mjs [sessionTitle] [sessionId]

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.DSH_TARGET ?? "http://127.0.0.1:3080";
const SESSION_TITLE = process.argv[2] ?? "swarm experiment 009";
const SESSION_ID = process.argv[3] ?? "session-47c63d2d-4d95-4ba4-9291-c361df7bac9b";
const AGENT_NAME = process.argv[4] ?? "HTML Writer";

function loadPlaywright() {
  const uiPkg = join(__dirname, "..", "..", "dsh-agent-swarm-ui", "package.json");
  return createRequire(uiPkg)("playwright");
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text().slice(0, 200)); });

  try {
    await page.goto(HOST + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    // Open the session (unfold collapsed sidebar groups first; the workspace
    // heading itself is a toggle, so only click it if the target is still hidden).
    async function unfold() {
      for (let r = 0; r < 4; r++) {
        const es = page.getByText(/^展开/);
        const c = await es.count().catch(() => 0);
        if (c === 0) break;
        for (let i = 0; i < c; i++) { await es.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
      }
    }
    await unfold();
    const title = page.getByText(SESSION_TITLE, { exact: true }).first();
    if (!(await title.isVisible().catch(() => false))) {
      await page.getByText("Swarm Experiments", { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(400);
      await unfold();
    }
    await title.waitFor({ state: "visible", timeout: 15000 });
    await title.click();
    await page.waitForTimeout(5000);

    await page.locator(".das-swarm-card").first().waitFor({ state: "visible", timeout: 15000 });
    check("inline swarm card present (chat node)", true);

    // 1. Agent click → detail popup.
    await page.getByText(AGENT_NAME, { exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    const popupOpen = await page.getByText("Open Workspace").first().isVisible().catch(() => false);
    check("agent click opens the detail popup", popupOpen);
    // Close the popup (its ✕) before the next step.
    await page.getByRole("button", { name: "✕" }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    // 2. Canvas.
    const canvasBtn = page.getByTitle("Open Orchestration Canvas").first();
    check("canvas button visible", await canvasBtn.isVisible().catch(() => false));
    await canvasBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const boardOpen = (await page.getByTestId("link-count").count().catch(() => 0)) >= 1;
    check("canvas opens the orchestrator board", boardOpen);
    await page.getByTestId("close-btn").first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    // 3. Progress toggle (tasks ▣ ↔ percent %).
    const pctBtn = page.getByTitle("Show percentage bar").first();
    check("progress toggle visible", await pctBtn.isVisible().catch(() => false));
    await pctBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
    check("percent mode applies to agent cards", body.includes("Task progress"));

    const relevantErrors = errors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
    check("no page errors during load", relevantErrors.length === 0, relevantErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

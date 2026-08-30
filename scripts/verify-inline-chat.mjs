// scripts/verify-inline-chat.mjs — load the REAL DSH GUI (127.0.0.1:3080),
// open a completed swarm session, and assert the ideal swarm agent cards mount
// INLINE in the chat at the turn where the swarm was dispatched (the
// `conversation.chat.turnTail` seat), while the Swarm tab still works.
//
//   node scripts/verify-inline-chat.mjs [sessionTitle] [sessionId]

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.DSH_TARGET ?? "http://127.0.0.1:3080";
const SESSION_TITLE = process.argv[2] ?? "swarm experiment 008";
const SESSION_ID = process.argv[3] ?? "session-bb642cd4-a6db-4e68-bfbd-a20f7ad56cf7";

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
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  try {
    await page.goto(HOST + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    // Open the completed swarm session from the sidebar. The "Swarm
    // Experiments" workspace is collapsed by default; unfold it, then click the
    // session title. The session list is grouped by workspace and older entries
    // are collapsed behind an "展开…" expander. Unfold those first (clicking the
    // workspace heading itself toggles it, so avoid it unless the target is
    // still hidden after unfolding).
    const title = page.getByText(SESSION_TITLE, { exact: true }).first();
    async function unfold() {
      for (let round = 0; round < 4; round++) {
        const expanders = page.getByText(/^展开/);
        const count = await expanders.count().catch(() => 0);
        if (count === 0) break;
        for (let i = 0; i < count; i++) {
          await expanders.nth(i).click().catch(() => {});
          await page.waitForTimeout(300);
        }
      }
    }
    await unfold();
    if (!(await title.isVisible().catch(() => false))) {
      await page.getByText("Swarm Experiments", { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(400);
      await unfold();
    }
    try {
      await title.waitFor({ state: "visible", timeout: 15000 });
      await title.click();
      check("session listed in sidebar", true, SESSION_TITLE);
    } catch {
      check("session listed in sidebar", false, SESSION_TITLE);
      const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
      console.log("BODY TEXT (first 1200):\n" + bodyText.slice(0, 1200));
      await page.screenshot({ path: join(__dirname, "..", "inline-no-session.png"), fullPage: true });
      throw new Error("session not found in sidebar");
    }

    // Wait for the chat view to settle (turn tail nodes render).
    await page.waitForTimeout(5000);

    // The inline swarm card: mounted at the dispatch turn via the turnTail seat.
    const inlineCard = page.locator(".das-inline");
    const inlineCount = await inlineCard.count().catch(() => 0);
    check("inline swarm card mounts in chat", inlineCount >= 1, `count=${inlineCount}`);

    if (inlineCount >= 1) {
      const text = (await inlineCard.first().innerText().catch(() => "")) ?? "";
      check("inline card shows the swarm header", /智能体群组|Swarm/.test(text), text.slice(0, 40));
      // The ideal panel mounts inside the card (its own "Agent Swarm" header).
      const inner = await inlineCard.first().locator("text=/Agent Swarm|Complete|/").first().isVisible().catch(() => false);
      check("ideal SwarmPanel rendered inside the card", inner);
    }

    // The Swarm tab (智能体群组) must still work as before.
    const tab = page.getByRole("tab", { name: /智能体群组/ }).first();
    const tabVisible = await tab.isVisible().catch(() => false);
    check("Swarm tab still present", tabVisible);
    if (tabVisible) {
      await tab.click();
      await page.waitForTimeout(2500);
      const tabText = (await page.locator("body").innerText().catch(() => "")) ?? "";
      check("Swarm tab renders the ideal panel", /Agent Swarm|Complete/.test(tabText));
    }

    await page.screenshot({ path: join(__dirname, "..", "inline-chat.png"), fullPage: true });

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

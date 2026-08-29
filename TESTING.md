# Testing dsh-agent-swarm

The plugin is tested across four layers, from pure logic up to a browser-driven
visual check of the UI wired to the real host half.

## Layers

| Layer | Where | What it proves | Run |
|-------|-------|----------------|-----|
| Unit (store) | `test/store.test.mjs` | The durable projection store round-trips, sanitizes, and clamps hostile input. | `node --test` |
| Host e2e | `test/host-e2e.test.mjs` | The full orchestration lifecycle (recruit → plan → confirm → spawn → summarize), the `/swarm` command, the model context, and the HTTP data plane — against a faithful fake Cordis ctx. | `node --test` |
| Client functional | `test/client.test.mjs` | The browser bundle (`lib/client.js`) registers the `conversation.view` "Swarm" slot and renders without a browser (vm sandbox + stub React). | `node --test` |
| Swarm-tab render | `dsh-agent-swarm-ui/src/components/__tests__/swarmTab.test.tsx` | Renders the client bundle's Swarm tab with real React + jsdom against a mocked `/swarm/state`; guards against the `[object Object]` bug where a React element was stringified into a text cell. | `pnpm test:run` (in the UI) |
| UI bridge integration | `dsh-agent-swarm-ui/src/api/__tests__/live.test.ts` | `LiveDshBridge` polls `/swarm/state`, synthesizes a `SimFrame`, maps plan/todos/logs, and POSTs confirm/cancel — against the plugin's exact wire shape. | `pnpm test:run` (in the UI) |
| FE visual e2e | `dsh-agent-swarm-ui/e2e/run-e2e.mjs` | **End to end**: mounts the REAL `lib/index.js` `apply` on a real `node:http` server, serves the built UI, and drives it in system Chrome via Playwright — asserting the swarm panel renders and transitions awaiting_confirm → executing → complete. | `pnpm test:e2e` (in the UI) |

## The host-e2e fake ctx

`test/helpers/fake-ctx.mjs` is a faithful-enough Cordis context double. It
implements exactly the surface `apply(ctx)` touches (`ctx.sessions` as an
injected property, `ctx.get("agents"/"subagents")`, `ctx.provide`/`on`/`inject`/
`logger`, and the `systemPrompt`/`commands`/`webServer` injection scopes). A
controllable `subagents` double (`createFakeSubagents`) lets tests settle
one-shot child runs and assert what the seam was asked to do.

## The visual e2e (the important one)

`dsh-agent-swarm-ui/e2e/run-e2e.mjs` is the answer to "does the FE work as
expected in DSH". It does NOT mock the HTTP layer:

1. `e2e/mock-dsh.mjs` mounts the real `dsh-agent-swarm/lib/index.js` `apply`
   against a real `node:http` server (the fake ctx's `webServer.register` binds
   the plugin's actual `/swarm/state` route), seeds two sessions, and serves the
   built UI from `dist/`.
2. Playwright launches system Chrome (`channel: "chrome"` — no browser download
   needed), loads `/?session=s1`, and asserts the swarm panel, roster, and
   phase badge render; clicks **Allow** and asserts the transition to
   `executing`; then loads `/?session=s2` and asserts the completion banner.
3. Screenshots land in `e2e/.artifacts/` (git-ignored).

Requirements: a built UI (`vite build` — the `test:e2e` script does it) and a
Chrome/Chromium on PATH (or `PLAYWRIGHT_PATH` pointing at a `playwright` install).

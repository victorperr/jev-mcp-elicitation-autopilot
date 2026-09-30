# Elicitation Autopilot for MCP servers

**Test** the **human-in-the-loop branches** of an **MCP** server, unattended, in CI.

![Python](https://img.shields.io/badge/python-3.10%2B-blue)

---

> ⚠️ Work in Progress: This project is currently a work in progress and may contain bugs or breaking changes. Use with caution.

This repository is a fork of the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(© Model Context Protocol a Series of LF Projects, LLC — see [Attribution](#attribution)).
On top of it, add **`--elicit`**: the CLI answers a server's
[elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
forms itself, as a simulated user whose decisions are made by
[TypeSafe's Jev](https://docs.typesafe.ai), a decision model.

## 💡 Why this project ?

MCP servers ask the user things mid-call: _"This will delete 42,118 rows from prod. Continue?"_,
_"Which environment?"_. Those confirmation and choice branches are the riskiest code a server has, and nothing tests them automatically: the upstream CLI connects with elicitation **off**, so a script can never reach the branch that consumes the answer.

## What `--elicit` does

```bash
TYPESAFE_API_KEY=… mcp-inspector --cli <server> --method tools/call \
  --tool-name drop_table --tool-arg table=orders \
  --elicit jev --elicit-policy "Cautious operator. Never approves deleting production data." \
  --elicit-default ticket=CHG-1234
```

```jsonc
// stderr — one transcript line per elicitation
{"elicitation":{"message":"This will permanently delete 42,118 rows…","mode":"jev","model":"jev-1.13.0",
 "action":{"value":"decline","probability":0.93},"fields":[]}}
```

Swap the policy for an eager user and the same command exercises the **accept** branch: two plain-English policies cover both sides of a confirmation, with no mocks.

**How an elicitation becomes one Jev request.** MCP restricts a form's `requestedSchema` to flat primitive fields, and most of them are decisions, not text:

| Form field                               | Jev question                                          |
| ---------------------------------------- | ----------------------------------------------------- |
| the response itself                      | `choice`: accept / decline / cancel                   |
| single-select (`enum`, `oneOf`)          | `choice` over the options                             |
| multi-select (array of enum)             | one `noul` (yes/no) per option                        |
| `boolean`                                | `noul`                                                |
| `string`, `number`                       | never guessed: `--elicit-default`, else the schema `default` |

All questions are answered in parallel against the same state (policy, message, form, the tool call that triggered it) in **one request**, so a whole form costs roughly one decision call.

**Design decisions**

- **Probabilities are thresholded, not argmaxed.** Jev cannot abstain, so an answer in the
  ambiguous band is never acted on: the server receives `cancel` (it is never left hanging), the
  tool result is withheld, and the run exits `9`. An ambiguous form is itself a finding: if a
  policy-driven user cannot decide, a human may not either.
- **Deterministic CI via record/replay.** `--elicit-record` stores Jev's raw answers keyed by a
  SHA-256 of the exact request; `--elicit-replay` needs no key and no network, re-applies the
  *current* threshold, and exits `10` when the server's form, the policy or the defaults changed.
- **Untrusted input is narrowed, not cast.** Both the server's schema and Jev's response are
  validated field by field; an off-spec field becomes `unsupported` instead of crashing the run.
- **No new dependency.** Jev is one `fetch` call through the existing proxy-aware fetch, with
  exponential backoff on `429`/`529`.
- **`--elicit defaults`** answers from defaults alone, with no model call.

Full flag reference: [CLI README → Unattended elicitation](./clients/cli/README.md#unattended-elicitation---elicit).

### 🔍 Where the new code is

| File | Role |
| --- | --- |
| [`clients/cli/src/elicit/jev-elicitation.ts`](./clients/cli/src/elicit/jev-elicitation.ts) | Pure mapping: schema → fields → Jev questions → thresholded decision |
| [`clients/cli/src/elicit/elicitation-autopilot.ts`](./clients/cli/src/elicit/elicitation-autopilot.ts) | Subscribes to the client's pending-elicitation queue, record/replay, failure → exit code |
| [`clients/cli/src/elicit/jev-client.ts`](./clients/cli/src/elicit/jev-client.ts) · [`jev-types.ts`](./clients/cli/src/elicit/jev-types.ts) | HTTP client and wire types for `POST /v1/systemone` |
| [`clients/cli/__tests__/elicit-cli.test.ts`](./clients/cli/__tests__/elicit-cli.test.ts) | End to end: real CLI → real MCP test server → stubbed Jev endpoint |
| [`clients/cli/__tests__/`](./clients/cli/__tests__) `jev-*.test.ts`, `elicitation-autopilot.test.ts` | Unit tests for every decision path |

## Quick start

Requires Node `>=22.19.0`.

```bash
npm install                 # root install cascades into every client
npm run build
cd clients/cli && npx vitest run elicit jev-   # the feature's tests
```

## Connecting to Jev

1. Get an API key from [TypeSafe](https://typesafe.ai) (access currently goes through a waitlist).
2. Expose it as an environment variable. The CLI reads it from the environment only; there is
   no `.env` loading, so the key never needs to live in a file inside the repo.

   ```bash
   export TYPESAFE_API_KEY="ts-…"          # bash / zsh
   ```

   ```powershell
   $env:TYPESAFE_API_KEY = "ts-…"          # PowerShell (current session)
   ```

3. Run any call with `--elicit jev`. Requests go to `POST https://api.typesafe.ai/v1/systemone`;
   set `TYPESAFE_API_URL` to point elsewhere (the end-to-end tests use it to target a local stub).

No key? `--elicit defaults` needs none, and `--elicit-replay <file>` replays a recorded run
offline, which is how CI should run it.

## The rest of the `mcp-inspector`

Everything outside `clients/cli/src/elicit/` is the upstream MCP Inspector v2 (web UI, TUI, CLI,
shared `core/`), kept intact so the fork builds and tests as a whole. Its documentation is
unchanged: [web](./clients/web/README.md) · [cli](./clients/cli/README.md) · [tui](./clients/tui/README.md) ·
[launcher](./clients/launcher/README.md) · [architecture](./docs/architecture.md) ·
[test servers](./docs/test-servers.md) · [quality gate](./docs/quality-gate.md) ·
[smoke-testing a server](./docs/cli-smoke-testing.md).

## Attribution

- **Upstream:** [modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector),
  © 2024-2025 Model Context Protocol a Series of LF Projects, LLC, and its contributors.
  This fork is based on its v2.8.0 release. It is **not affiliated with or endorsed by** the
  Model Context Protocol project.
- **My contribution:** the elicitation autopilot listed above, plus the integration changes to
  existing files, each of which carries a `Modified by Victor` notice. [`NOTICE`](./NOTICE)
  lists every change, including the upstream material removed from this fork.
- **Jev** is a product of TypeSafe; this project only calls its public API.

## License

[`LICENSE`](./LICENSE) is unchanged from upstream (Apache-2.0, with MIT for contributions not yet
relicensed, and CC-BY-4.0 for documentation). My additions are released under Apache-2.0.

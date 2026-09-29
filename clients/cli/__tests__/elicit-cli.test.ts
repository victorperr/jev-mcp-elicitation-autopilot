// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * `--elicit` end to end: the real CLI, in process, against a real MCP test
 * server whose `collect_elicitation` tool elicits a form and echoes the
 * answer, with TypeSafe's API replaced by a local HTTP stub via
 * `TYPESAFE_API_URL`. What the tool echoes is what the server received, so
 * each assertion is on the server's side of the exchange.
 */
import { afterAll, beforeAll, afterEach, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCollectFormElicitationTool,
  createTestServerHttp,
  createTestServerInfo,
} from "@modelcontextprotocol/inspector-test-server";
import { runCli, type CliResult } from "./helpers/cli-runner.js";
import { expectCliFailure, expectValidJson } from "./helpers/assertions.js";
import { EXIT_CODES } from "../src/error-handler.js";
import type { JevRequest, JevResponse } from "../src/elicit/jev-types.js";

const FORM = {
  message:
    "This will permanently delete 42,118 rows from orders (prod). Continue?",
  schema: {
    type: "object",
    properties: {
      confirm: { type: "boolean", title: "I understand this cannot be undone" },
      env: { type: "string", enum: ["staging", "prod"] },
      ticket: { type: "string", title: "Change ticket" },
    },
    required: ["confirm", "ticket"],
  },
};

const mcp = createTestServerHttp({
  serverInfo: createTestServerInfo(),
  tools: [createCollectFormElicitationTool()],
});

/** The stub's answer to the next request, and everything it was sent. */
let reply: (request: JevRequest) => JevResponse;
const received: { auth?: string; body: JevRequest }[] = [];

const jev: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as JevRequest;
    received.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply(body)));
  });
});
let jevUrl = "";

const dir = mkdtempSync(join(tmpdir(), "elicit-cli-"));

beforeAll(async () => {
  await mcp.start();
  await new Promise<void>((r) => jev.listen(0, "127.0.0.1", () => r()));
  const addr = jev.address();
  jevUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1/systemone`;
});

afterAll(async () => {
  await mcp.stop();
  await new Promise<void>((r) => jev.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  received.length = 0;
});

/** Answer every question: the given action, and "yes" / first option for fields. */
function answering(
  action: Record<string, number>,
  fieldYes = 0.97,
): (request: JevRequest) => JevResponse {
  return (request) => {
    const answers: JevResponse["answers"] = {};
    for (const [key, q] of Object.entries(request.questions)) {
      if (key === "action") {
        const [choice] = Object.entries(action).sort((a, b) => b[1] - a[1])[0]!;
        answers[key] = {
          type: "choice",
          choice,
          probabilities: action,
          confidence: 1,
        };
      } else if (q.type === "noul") {
        answers[key] = { type: "noul", noul: fieldYes };
      } else {
        const [first, ...rest] = Object.keys(q.criteria);
        answers[key] = {
          type: "choice",
          choice: first!,
          probabilities: Object.fromEntries([
            [first!, 0.9],
            ...rest.map((k) => [k, 0.1 / rest.length]),
          ]),
          confidence: 0.9,
        };
      }
    }
    return { model: "jev-1.13.0", answers };
  };
}

function callArgs(...extra: string[]): string[] {
  return [
    mcp.url,
    "--cli",
    "--method",
    "tools/call",
    "--tool-name",
    "collect_elicitation",
    "--tool-args-json",
    JSON.stringify(FORM),
    ...extra,
  ];
}

const env = () => ({ TYPESAFE_API_KEY: "test-key", TYPESAFE_API_URL: jevUrl });

/** The ElicitResult the server received, read back from the tool's echo. */
function serverSaw(result: CliResult): unknown {
  const text = expectValidJson(result).content[0].text as string;
  return JSON.parse(text.replace(/^Elicitation response: /, ""));
}

describe("--elicit jev", () => {
  it("answers the server's form as the policy's user would", async () => {
    reply = answering({ accept: 0.93, decline: 0.05, cancel: 0.02 });
    const result = await runCli(
      callArgs(
        "--elicit",
        "jev",
        "--elicit-policy",
        "Operator cleaning up staging data",
        "--elicit-default",
        "ticket=CHG-1234",
      ),
      { env: env() },
    );
    expect(result.exitCode).toBe(0);
    expect(serverSaw(result)).toEqual({
      action: "accept",
      content: { confirm: true, env: "staging", ticket: "CHG-1234" },
    });
    // One request, authenticated, carrying the policy and the tool call.
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe("Bearer test-key");
    expect(received[0]!.body.state).toMatchObject({
      user_policy: "Operator cleaning up staging data",
      triggered_by_tool_call: { name: "collect_elicitation" },
    });
    // The transcript goes to stderr, so stdout stays the method's result.
    const transcript = JSON.parse(
      result.stderr.split("\n").find((l) => l.includes('"elicitation"'))!,
    );
    expect(transcript.elicitation.action).toEqual({
      value: "accept",
      probability: 0.93,
    });
  });

  it("sends a confident decline, exercising the server's refusal branch", async () => {
    reply = answering({ decline: 0.96, accept: 0.04 });
    const result = await runCli(callArgs("--elicit", "jev"), { env: env() });
    expect(result.exitCode).toBe(0);
    expect(serverSaw(result)).toEqual({ action: "decline" });
  });

  it("exits 9 on an ambiguous answer without printing the tool result", async () => {
    reply = answering({ accept: 0.5, decline: 0.45, cancel: 0.05 });
    const result = await runCli(callArgs("--elicit", "jev"), { env: env() });
    expect(result.exitCode).toBe(EXIT_CODES.ELICITATION_AMBIGUOUS);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code":"elicitation_ambiguous"');
    expect(result.stderr).toContain("accept 0.5 / decline 0.45");
  });

  it("honours --elicit-threshold", async () => {
    reply = answering({ accept: 0.7, decline: 0.3 }, 0.99);
    const result = await runCli(
      callArgs(
        "--elicit",
        "jev",
        "--elicit-threshold",
        "0.65",
        "--elicit-default",
        "ticket=T-1",
      ),
      { env: env() },
    );
    expect(result.exitCode).toBe(0);
    expect(serverSaw(result)).toMatchObject({ action: "accept" });
  });

  it("records a run and replays it with no key and no Jev", async () => {
    const recording = join(dir, "run.json");
    reply = answering({ decline: 0.99, accept: 0.01 });
    const recorded = await runCli(
      callArgs("--elicit", "jev", "--elicit-record", recording),
      { env: env() },
    );
    expect(recorded.exitCode).toBe(0);
    expect(existsSync(recording)).toBe(true);

    const replayed = await runCli(
      callArgs("--elicit", "jev", "--elicit-replay", recording),
      { env: { TYPESAFE_API_KEY: "", TYPESAFE_API_URL: "http://127.0.0.1:1" } },
    );
    expect(replayed.exitCode).toBe(0);
    expect(serverSaw(replayed)).toEqual({ action: "decline" });
    expect(received).toHaveLength(1);

    // A different policy is a different request: the recording cannot answer it.
    const stale = await runCli(
      callArgs(
        "--elicit",
        "jev",
        "--elicit-replay",
        recording,
        "--elicit-policy",
        "someone else",
      ),
    );
    expect(stale.exitCode).toBe(EXIT_CODES.ELICITATION_NOT_RECORDED);
  });

  it("reads the policy from a file with @path", async () => {
    const policyFile = join(dir, "policy.txt");
    writeFileSync(policyFile, "  Never approves anything on prod.\n");
    reply = answering({ decline: 0.9, accept: 0.1 });
    const result = await runCli(
      callArgs("--elicit", "jev", "--elicit-policy", `@${policyFile}`),
      { env: env() },
    );
    expect(result.exitCode).toBe(0);
    expect(received[0]!.body.state.user_policy).toBe(
      "Never approves anything on prod.",
    );
  });

  it("fails before connecting when the policy file is unreadable", async () => {
    const result = await runCli(
      callArgs("--elicit", "jev", "--elicit-policy", `@${join(dir, "nope")}`),
      { env: env() },
    );
    expectCliFailure(result);
    expect(result.stderr).toContain("--elicit-policy: cannot read");
  });

  it("fails as a usage error without TYPESAFE_API_KEY", async () => {
    const result = await runCli(callArgs("--elicit", "jev"), {
      env: { TYPESAFE_API_KEY: "" },
    });
    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain('"code":"elicitation_no_api_key"');
  });
});

describe("--elicit defaults", () => {
  it("accepts with --elicit-default values and no model call", async () => {
    const result = await runCli(
      callArgs(
        "--elicit",
        "defaults",
        "--elicit-default",
        "confirm=true",
        "env=prod",
        "ticket=42",
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(serverSaw(result)).toEqual({
      action: "accept",
      content: { confirm: true, env: "prod", ticket: "42" },
    });
    expect(received).toHaveLength(0);
  });

  it("names the missing flag when a required field has no value", async () => {
    const result = await runCli(callArgs("--elicit", "defaults"));
    expect(result.exitCode).toBe(EXIT_CODES.USAGE);
    expect(result.stderr).toContain("pass --elicit-default confirm=<value>");
  });
});

describe("--elicit flag validation", () => {
  it.each([
    [["--elicit-policy", "x"], "--elicit-policy requires --elicit."],
    [["--elicit-default", "a=1"], "--elicit-default requires --elicit."],
    [["--elicit-threshold", "0.9"], "--elicit-threshold requires --elicit."],
    [["--elicit-record", "r.json"], "--elicit-record requires --elicit."],
    [["--elicit-replay", "r.json"], "--elicit-replay requires --elicit."],
    [
      ["--elicit", "jev", "--elicit-record", "a", "--elicit-replay", "b"],
      "--elicit-record cannot be combined with --elicit-replay.",
    ],
    [["--elicit", "defaults", "--elicit-record", "a"], "require --elicit jev"],
    [["--elicit", "maybe"], "--elicit must be jev or defaults."],
    [
      ["--elicit", "jev", "--elicit-threshold", "0.5"],
      "must be a number in (0.5, 1]",
    ],
    [
      ["--elicit", "jev", "--elicit-threshold", "x"],
      "must be a number in (0.5, 1]",
    ],
  ])("rejects %j", async (flags, message) => {
    const result = await runCli(["--method", "tools/list", ...flags]);
    expectCliFailure(result);
    expect(result.stderr).toContain(message);
  });
});

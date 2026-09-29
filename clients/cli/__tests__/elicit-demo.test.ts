// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Keeps `examples/elicitation-demo` working: the documented demo commands,
 * run in process against the demo server over stdio. Jev is replaced by a
 * local stub that answers as the policy in the request says, so the test
 * checks the wiring end to end, not Jev's judgement.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliResult } from "./helpers/cli-runner.js";
import { expectValidJson } from "./helpers/assertions.js";
import type { JevRequest, JevResponse } from "../src/elicit/jev-types.js";

const demoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/elicitation-demo",
);
const serverPath = path.join(demoDir, "server.mjs");

/** Stub Jev: a policy mentioning "Never approves" declines, anything else accepts. */
const jev: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const request = JSON.parse(raw) as JevRequest;
    const refuses = String(request.state.user_policy).includes(
      "Never approves",
    );
    const answers: JevResponse["answers"] = {};
    for (const [key, q] of Object.entries(request.questions)) {
      if (key === "action") {
        const probabilities = refuses
          ? { accept: 0.04, decline: 0.94, cancel: 0.02 }
          : { accept: 0.95, decline: 0.03, cancel: 0.02 };
        answers[key] = {
          type: "choice",
          choice: refuses ? "decline" : "accept",
          probabilities,
          confidence: 0.9,
        };
      } else if (q.type === "noul") {
        answers[key] = { type: "noul", noul: 0.97 };
      } else {
        answers[key] = {
          type: "choice",
          choice: "snapshot",
          probabilities: { none: 0.01, snapshot: 0.93, full: 0.06 },
          confidence: 0.9,
        };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "jev-stub", answers }));
  });
});
let jevUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => jev.listen(0, "127.0.0.1", () => r()));
  const addr = jev.address();
  jevUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => jev.close(() => r()));
});

function dropOrders(...extra: string[]): Promise<CliResult> {
  return runCli(
    [
      "node",
      serverPath,
      "--method",
      "tools/call",
      "--tool-name",
      "drop_table",
      "--tool-arg",
      "table=orders",
      ...extra,
    ],
    { env: { TYPESAFE_API_KEY: "demo", TYPESAFE_API_URL: jevUrl } },
  );
}

function toolText(result: CliResult): string {
  expect(result.exitCode).toBe(0);
  return expectValidJson(result).content[0].text as string;
}

describe("examples/elicitation-demo", () => {
  it("defaults mode: drops the table with the given answers", async () => {
    const result = await dropOrders(
      "--elicit",
      "defaults",
      "--elicit-default",
      "confirm=true",
      "backup=full",
      "ticket=CHG-1234",
    );
    expect(toolText(result)).toBe(
      'Dropped "orders" (42,118 rows). Backup: full. Ticket: CHG-1234.',
    );
  });

  it("defaults mode: an unticked box takes the server's abort branch", async () => {
    const result = await dropOrders(
      "--elicit",
      "defaults",
      "--elicit-default",
      "confirm=false",
      "backup=none",
      "ticket=CHG-1234",
    );
    expect(toolText(result)).toContain("confirmation box was not ticked");
  });

  it("jev mode: the cautious policy declines", async () => {
    const result = await dropOrders(
      "--elicit",
      "jev",
      "--elicit-policy",
      `@${path.join(demoDir, "policies", "cautious.txt")}`,
      "--elicit-default",
      "ticket=CHG-1234",
    );
    expect(toolText(result)).toBe(
      'Aborted: the user declined. "orders" is untouched.',
    );
  });

  it("jev mode: the eager policy accepts and Jev picks the backup", async () => {
    const result = await dropOrders(
      "--elicit",
      "jev",
      "--elicit-policy",
      `@${path.join(demoDir, "policies", "eager.txt")}`,
      "--elicit-default",
      "ticket=CHG-1234",
    );
    expect(toolText(result)).toBe(
      'Dropped "orders" (42,118 rows). Backup: snapshot. Ticket: CHG-1234.',
    );
  });
});

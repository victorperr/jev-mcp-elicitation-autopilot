// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitRequest } from "@modelcontextprotocol/client";
import {
  ElicitationAutopilot,
  fingerprintRequest,
  type AutopilotConfig,
} from "../src/elicit/elicitation-autopilot.js";
import { ACTION_QUESTION, fieldKey } from "../src/elicit/jev-elicitation.js";
import type { JevRequest, JevResponse } from "../src/elicit/jev-types.js";
import { CliExitCodeError, EXIT_CODES } from "../src/error-handler.js";

const dir = mkdtempSync(join(tmpdir(), "elicit-autopilot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function formRequest(message = "Delete 42 rows?"): ElicitRequest {
  return {
    method: "elicitation/create",
    params: {
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean" },
          env: { type: "string", enum: ["staging", "prod"] },
        },
        required: ["confirm"],
      },
    },
  };
}

function jevAnswer(
  action: Record<string, number>,
  confirm = 0.95,
  env: Record<string, number> = { staging: 0.9, prod: 0.1 },
): JevResponse {
  const winner = (p: Record<string, number>) =>
    Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0];
  return {
    model: "jev-1.13.0",
    answers: {
      [ACTION_QUESTION]: {
        type: "choice",
        choice: winner(action),
        probabilities: action,
        confidence: 1,
      },
      [fieldKey(0)]: { type: "noul", noul: confirm },
      [fieldKey(1)]: {
        type: "choice",
        choice: winner(env),
        probabilities: env,
        confidence: 1,
      },
    },
  };
}

function config(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    mode: "jev",
    policy: "cautious operator",
    overrides: {},
    threshold: 0.8,
    ...overrides,
  };
}

async function exitCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CliExitCodeError) return err.exitCode;
    throw err;
  }
  throw new Error("expected a CliExitCodeError");
}

describe("ElicitationAutopilot", () => {
  it("answers from Jev and logs one transcript line", async () => {
    const lines: string[] = [];
    const asked: JevRequest[] = [];
    const autopilot = await ElicitationAutopilot.create(
      config({ toolCall: { name: "drop_table", arguments: { t: "orders" } } }),
      {
        ask: async (request) => {
          asked.push(request);
          return jevAnswer({ accept: 0.9, decline: 0.1 });
        },
        log: async (line) => {
          lines.push(line);
        },
      },
    );
    await expect(autopilot.answer(formRequest())).resolves.toEqual({
      action: "accept",
      content: { confirm: true, env: "staging" },
    });
    await autopilot.settle();
    expect(asked[0]!.state).toMatchObject({
      user_policy: "cautious operator",
      triggered_by_tool_call: { name: "drop_table" },
    });
    const logged = JSON.parse(lines[0]!);
    expect(logged.elicitation).toMatchObject({
      message: "Delete 42 rows?",
      mode: "jev",
      model: "jev-1.13.0",
      action: { value: "accept", probability: 0.9 },
    });
    expect(logged.elicitation).not.toHaveProperty("problems");
  });

  it("cancels an ambiguous elicitation and settles with exit 9", async () => {
    const lines: string[] = [];
    const autopilot = await ElicitationAutopilot.create(config(), {
      ask: async () => jevAnswer({ accept: 0.5, decline: 0.5 }),
      log: async (line) => {
        lines.push(line);
      },
    });
    await expect(autopilot.answer(formRequest())).resolves.toEqual({
      action: "cancel",
    });
    expect(JSON.parse(lines[0]!).elicitation.problems).toHaveLength(1);
    expect(await exitCodeOf(autopilot.settle())).toBe(
      EXIT_CODES.ELICITATION_AMBIGUOUS,
    );
  });

  it("reports an unfilled required field as a usage error", async () => {
    const autopilot = await ElicitationAutopilot.create(
      config({ mode: "defaults" }),
      { log: async () => {} },
    );
    await expect(autopilot.answer(formRequest())).resolves.toEqual({
      action: "cancel",
    });
    await expect(autopilot.settle()).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE,
      envelope: { code: "elicitation_unfilled" },
    });
  });

  it("fills from defaults without calling anything in defaults mode", async () => {
    const autopilot = await ElicitationAutopilot.create(
      config({ mode: "defaults", overrides: { confirm: false } }),
      { log: async () => {} },
    );
    await expect(autopilot.answer(formRequest())).resolves.toEqual({
      action: "accept",
      content: { confirm: false },
    });
    await autopilot.settle();
  });

  it("cancels and rethrows when Jev fails", async () => {
    const autopilot = await ElicitationAutopilot.create(config(), {
      ask: async () => {
        throw new Error("Jev request failed with HTTP 500");
      },
      log: async () => {},
    });
    await expect(autopilot.answer(formRequest())).resolves.toEqual({
      action: "cancel",
    });
    await expect(autopilot.settle()).rejects.toThrow("HTTP 500");
  });

  it("records a string failure as an Error", async () => {
    const autopilot = await ElicitationAutopilot.create(config(), {
      ask: () => Promise.reject("plain string"),
      log: async () => {},
    });
    await autopilot.answer(formRequest());
    await expect(autopilot.settle()).rejects.toThrow("plain string");
  });

  it("declines URL-mode elicitations, which need a browser", async () => {
    const lines: string[] = [];
    const autopilot = await ElicitationAutopilot.create(config(), {
      ask: async () => {
        throw new Error("must not be called");
      },
      log: async (line) => {
        lines.push(line);
      },
    });
    const request: ElicitRequest = {
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Sign in",
        url: "https://example.com/login",
        elicitationId: "e1",
      },
    };
    await expect(autopilot.answer(request)).resolves.toEqual({
      action: "decline",
    });
    expect(lines[0]).toContain("needs a browser");
    await autopilot.settle();
  });

  it("records Jev's answers and replays them without a key", async () => {
    const path = join(dir, "recording.json");
    const recorder = await ElicitationAutopilot.create(
      config({ recordPath: path }),
      {
        ask: async () => jevAnswer({ decline: 0.97, accept: 0.03 }),
        log: async () => {},
      },
    );
    await expect(recorder.answer(formRequest())).resolves.toEqual({
      action: "decline",
    });
    await recorder.settle();
    const recording = JSON.parse(readFileSync(path, "utf8"));
    expect(recording.version).toBe(1);
    expect(recording.entries).toHaveLength(1);
    expect(recording.entries[0].message).toBe("Delete 42 rows?");

    const replayer = await ElicitationAutopilot.create(
      config({ replayPath: path }),
      { env: {}, log: async () => {} },
    );
    await expect(replayer.answer(formRequest())).resolves.toEqual({
      action: "decline",
    });
    await replayer.settle();
  });

  it("fails a replay with exit 10 when the form changed", async () => {
    const path = join(dir, "stale.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            fingerprint: "not-this-one",
            message: "old",
            response: jevAnswer({ accept: 1 }),
          },
        ],
      }),
    );
    const replayer = await ElicitationAutopilot.create(
      config({ replayPath: path }),
      { log: async () => {} },
    );
    await replayer.answer(formRequest("A different question"));
    expect(await exitCodeOf(replayer.settle())).toBe(
      EXIT_CODES.ELICITATION_NOT_RECORDED,
    );
  });

  it("rejects an unreadable or malformed replay file up front", async () => {
    await expect(
      ElicitationAutopilot.create(
        config({ replayPath: join(dir, "missing.json") }),
      ),
    ).rejects.toMatchObject({
      envelope: { code: "elicitation_replay_unreadable" },
    });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, entries: [{}] }));
    await expect(
      ElicitationAutopilot.create(config({ replayPath: bad })),
    ).rejects.toThrow("is not an elicitation recording");
    const notJson = join(dir, "not-json.json");
    writeFileSync(notJson, "{");
    await expect(
      ElicitationAutopilot.create(config({ replayPath: notJson })),
    ).rejects.toThrow("cannot read");
    writeFileSync(bad, "null");
    await expect(
      ElicitationAutopilot.create(config({ replayPath: bad })),
    ).rejects.toThrow("is not an elicitation recording");
  });

  it("requires TYPESAFE_API_KEY for a live jev run", async () => {
    await expect(
      ElicitationAutopilot.create(config(), { env: { TYPESAFE_API_KEY: " " } }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE,
      envelope: { code: "elicitation_no_api_key" },
    });
    await expect(
      ElicitationAutopilot.create(config(), { env: { TYPESAFE_API_KEY: "k" } }),
    ).resolves.toBeInstanceOf(ElicitationAutopilot);
  });

  it("fingerprints change with the policy", () => {
    const a: JevRequest = { model: "m", state: { p: 1 }, questions: {} };
    const b: JevRequest = { model: "m", state: { p: 2 }, questions: {} };
    expect(fingerprintRequest(a)).toBe(fingerprintRequest({ ...a }));
    expect(fingerprintRequest(a)).not.toBe(fingerprintRequest(b));
  });
});

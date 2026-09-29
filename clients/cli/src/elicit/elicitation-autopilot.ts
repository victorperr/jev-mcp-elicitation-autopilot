// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Answers a server's form elicitations on the user's behalf, so a CLI run can
 * exercise human-in-the-loop tools unattended (`--elicit`).
 *
 * The CLI otherwise connects with elicitation off, which means a tool that asks
 * the user anything cannot be tested from a script at all: the branch that
 * consumes the answer is never reached. This class subscribes to the client's
 * pending-elicitation queue — the same queue the web UI renders as a modal —
 * and resolves each entry itself:
 *
 *  - `jev`: TypeSafe's Jev decides the action and every enum / boolean field
 *    against a plain-English policy (`jev-elicitation.ts` does the mapping);
 *  - `defaults`: accept, filling fields from `--elicit-default` and the
 *    schema's own defaults, with no model call at all.
 *
 * `--elicit-record` / `--elicit-replay` make the Jev mode reproducible in CI:
 * a recording stores Jev's raw answers keyed by a hash of the exact request,
 * so a replay needs no key and no network, re-applies the current threshold,
 * and fails loudly when the server's form (or the policy) has changed.
 *
 * A problem never guesses and never hangs the server: the elicitation is
 * answered `cancel`, and the problem is re-thrown from {@link settle} once the
 * method returns, with its own exit code.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type { InspectorClient } from "@inspector/core/mcp/index.js";
import { CliExitCodeError, EXIT_CODES } from "../error-handler.js";
import { awaitableError } from "../utils/awaitable-log.js";
import { askJev, DEFAULT_JEV_MODEL } from "./jev-client.js";
import {
  buildJevRequest,
  decideElicitResult,
  parseRequestedSchema,
  type ElicitContext,
  type ElicitDecision,
} from "./jev-elicitation.js";
import {
  isJevResponse,
  type JevRequest,
  type JevResponse,
} from "./jev-types.js";

export type ElicitMode = "jev" | "defaults";
export const ELICIT_MODES: readonly ElicitMode[] = ["jev", "defaults"];

export interface AutopilotConfig {
  mode: ElicitMode;
  policy: string;
  overrides: Record<string, unknown>;
  threshold: number;
  recordPath?: string;
  replayPath?: string;
  /** The call being made, given to Jev as context for its decisions. */
  toolCall?: ElicitContext["toolCall"];
}

export interface AutopilotDeps {
  /** Replaces the HTTP call; defaults to {@link askJev} with the env key. */
  ask?: (request: JevRequest) => Promise<JevResponse>;
  env?: NodeJS.ProcessEnv;
  /** Receives one transcript line per elicitation; defaults to stderr. */
  log?: (line: string) => Promise<void>;
}

interface RecordingEntry {
  fingerprint: string;
  message: string;
  response: JevResponse;
}

interface Recording {
  version: 1;
  entries: RecordingEntry[];
}

function isRecording(value: unknown): value is Recording {
  if (typeof value !== "object" || value === null) return false;
  const { version, entries } = value as {
    version?: unknown;
    entries?: unknown;
  };
  return (
    version === 1 &&
    Array.isArray(entries) &&
    entries.every(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RecordingEntry).fingerprint === "string" &&
        isJevResponse((e as RecordingEntry).response),
    )
  );
}

/** Stable key for a Jev request: any change to form, policy or model moves it. */
export function fingerprintRequest(request: JevRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

async function loadRecording(path: string): Promise<Recording> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new CliExitCodeError(
      EXIT_CODES.USAGE,
      `--elicit-replay: cannot read ${path} (${err instanceof Error ? err.message : String(err)}).`,
      { code: "elicitation_replay_unreadable" },
    );
  }
  if (!isRecording(parsed)) {
    throw new CliExitCodeError(
      EXIT_CODES.USAGE,
      `--elicit-replay: ${path} is not an elicitation recording.`,
      { code: "elicitation_replay_unreadable" },
    );
  }
  return parsed;
}

/** Where Jev's answers come from for this run. */
type AnswerSource =
  | { kind: "none" }
  | { kind: "replay"; recording: Recording }
  | { kind: "live"; ask: (request: JevRequest) => Promise<JevResponse> };

export class ElicitationAutopilot {
  private readonly inflight: Promise<void>[] = [];
  private readonly failures: Error[] = [];
  private readonly recorded: RecordingEntry[] = [];

  private constructor(
    private readonly config: AutopilotConfig,
    private readonly source: AnswerSource,
    private readonly log: (line: string) => Promise<void>,
  ) {}

  /**
   * Validate the configuration against the environment and load a replay
   * file. Done up front, before connecting, so a missing key or an unreadable
   * recording fails as a usage error rather than mid-call.
   */
  static async create(
    config: AutopilotConfig,
    deps: AutopilotDeps = {},
  ): Promise<ElicitationAutopilot> {
    const env = deps.env ?? process.env;
    const log = deps.log ?? ((line: string) => awaitableError(line + "\n"));
    if (config.mode !== "jev") {
      return new ElicitationAutopilot(config, { kind: "none" }, log);
    }
    if (config.replayPath) {
      const recording = await loadRecording(config.replayPath);
      return new ElicitationAutopilot(
        config,
        { kind: "replay", recording },
        log,
      );
    }
    let ask = deps.ask;
    if (!ask) {
      const apiKey = env.TYPESAFE_API_KEY?.trim();
      if (!apiKey) {
        throw new CliExitCodeError(
          EXIT_CODES.USAGE,
          "--elicit jev needs a TypeSafe API key in TYPESAFE_API_KEY (or use --elicit-replay).",
          { code: "elicitation_no_api_key" },
        );
      }
      const url = env.TYPESAFE_API_URL?.trim() || undefined;
      ask = (request) => askJev(request, { apiKey, url });
    }
    return new ElicitationAutopilot(config, { kind: "live", ask }, log);
  }

  /** Subscribe to the client's pending-elicitation queue. */
  attach(client: InspectorClient): void {
    client.addEventListener("newPendingElicitation", (event) => {
      const pending = event.detail;
      // Held in `inflight` and awaited by `settle`, so it is not floating.
      this.inflight.push(
        this.answer(pending.request).then(
          (result) => pending.respond(result),
          /* v8 ignore next 3 -- `answer` catches everything itself; this is a
             guard against a future edit that lets it reject. */
          (err: unknown) => {
            this.fail(err);
          },
        ),
      );
    });
  }

  private fail(err: unknown): void {
    this.failures.push(err instanceof Error ? err : new Error(String(err)));
  }

  /**
   * Decide one elicitation. Never rejects: any problem is recorded for
   * {@link settle} and the server is told `cancel`, so it is never left
   * waiting on an answer that will not come.
   */
  async answer(request: ElicitRequest): Promise<ElicitResult> {
    const params = request.params;
    const message = params.message;
    if ("mode" in params && params.mode === "url") {
      await this.log(
        JSON.stringify({
          elicitation: { message, mode: "url", action: "decline" },
          note: "URL-mode elicitation needs a browser; declined.",
        }),
      );
      return { action: "decline" };
    }

    const requestedSchema =
      "requestedSchema" in params ? params.requestedSchema : undefined;
    const ctx: ElicitContext = {
      message,
      fields: parseRequestedSchema(requestedSchema),
      policy: this.config.policy,
      overrides: this.config.overrides,
      ...(this.config.toolCall && { toolCall: this.config.toolCall }),
    };

    try {
      const response = await this.resolveJev(ctx);
      const decision = decideElicitResult(ctx, response, {
        threshold: this.config.threshold,
      });
      await this.log(this.transcript(message, decision, response));
      if (!decision.result) {
        this.failures.push(this.problemError(message, decision));
        return { action: "cancel" };
      }
      return decision.result;
    } catch (err) {
      this.fail(err);
      return { action: "cancel" };
    }
  }

  private async resolveJev(
    ctx: ElicitContext,
  ): Promise<JevResponse | undefined> {
    if (this.source.kind === "none") return undefined;
    const request = buildJevRequest(ctx, DEFAULT_JEV_MODEL);
    const fingerprint = fingerprintRequest(request);
    if (this.source.kind === "replay") {
      const entry = this.source.recording.entries.find(
        (e) => e.fingerprint === fingerprint,
      );
      if (!entry) {
        throw new CliExitCodeError(
          EXIT_CODES.ELICITATION_NOT_RECORDED,
          `--elicit-replay has no answer for the elicitation "${ctx.message}": the form, the policy or the defaults changed since it was recorded. Re-record with --elicit-record.`,
          { code: "elicitation_not_recorded" },
        );
      }
      return entry.response;
    }
    const response = await this.source.ask(request);
    if (this.config.recordPath) {
      this.recorded.push({ fingerprint, message: ctx.message, response });
    }
    return response;
  }

  private transcript(
    message: string,
    decision: ElicitDecision,
    response: JevResponse | undefined,
  ): string {
    return JSON.stringify({
      elicitation: {
        message,
        mode: this.config.mode,
        ...(response && { model: response.model }),
        action: decision.action,
        fields: decision.fields,
        ...(decision.problems.length > 0 && { problems: decision.problems }),
      },
    });
  }

  private problemError(message: string, decision: ElicitDecision): Error {
    const ambiguous = decision.problems.some((p) => p.kind === "ambiguous");
    const detail = decision.problems.map((p) => p.message).join("; ");
    return ambiguous
      ? new CliExitCodeError(
          EXIT_CODES.ELICITATION_AMBIGUOUS,
          `Elicitation "${message}" is ambiguous under the policy: ${detail}. Clarify the server's form, sharpen --elicit-policy, or lower --elicit-threshold.`,
          { code: "elicitation_ambiguous" },
        )
      : new CliExitCodeError(
          EXIT_CODES.USAGE,
          `Elicitation "${message}" could not be filled: ${detail}.`,
          { code: "elicitation_unfilled" },
        );
  }

  /**
   * Wait for every elicitation answered during the run, write the recording,
   * and throw the first problem found. Called once the method has returned
   * (or thrown), so a problem outranks the downstream error it caused.
   */
  async settle(): Promise<void> {
    await Promise.all(this.inflight);
    if (this.config.recordPath) {
      const recording: Recording = { version: 1, entries: this.recorded };
      await writeFile(
        this.config.recordPath,
        JSON.stringify(recording, null, 2) + "\n",
        "utf8",
      );
    }
    if (this.failures.length > 0) throw this.failures[0];
  }
}

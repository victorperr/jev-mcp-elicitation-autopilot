// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Minimal HTTP client for TypeSafe's Jev decision API.
 *
 * One endpoint, one request shape, so it is a `fetch` call rather than an SDK
 * dependency — the repo's dependency rules make a new root runtime dependency
 * a real cost, and this needs nothing a `fetch` does not already provide.
 *
 * The fetch is injectable for tests and defaults to the CLI's proxy-aware
 * fetch, so a CI runner that reaches the internet only through `HTTPS_PROXY`
 * reaches Jev the same way it reaches MCP servers (#2067).
 */
import { createProxyFetch } from "@inspector/core/mcp/node/index.js";
import {
  isJevResponse,
  type JevRequest,
  type JevResponse,
} from "./jev-types.js";

export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

/** Statuses TypeSafe documents as retryable: rate limited, overloaded. */
const RETRYABLE = new Set([429, 529]);

export interface JevClientOptions {
  apiKey: string;
  url?: string;
  fetch?: typeof fetch;
  /** Per-attempt budget. A decision call answers in well under a second. */
  timeoutMs?: number;
  /** Retries after the first attempt, on 429 / 529 only. */
  retries?: number;
  /** Backoff before retry `n` (0-based) is `baseDelayMs * 2^n`. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one decision request and return the validated response. Throws with
 * the HTTP status and TypeSafe's error body on a non-retryable failure, and
 * on a body that does not match the documented shape.
 */
export async function askJev(
  body: JevRequest,
  options: JevClientOptions,
): Promise<JevResponse> {
  const doFetch = options.fetch ?? createProxyFetch() ?? fetch;
  const url = options.url ?? DEFAULT_JEV_URL;
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });

    if (RETRYABLE.has(response.status) && attempt < retries) {
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Jev request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const json: unknown = await response.json();
    if (!isJevResponse(json)) {
      throw new Error(
        "Jev returned a response that is not a valid answer set.",
      );
    }
    return json;
  }
}

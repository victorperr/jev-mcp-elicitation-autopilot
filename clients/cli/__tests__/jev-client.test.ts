// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
import { describe, it, expect, vi } from "vitest";
import {
  askJev,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_URL,
} from "../src/elicit/jev-client.js";
import { isJevResponse, type JevRequest } from "../src/elicit/jev-types.js";

const REQUEST: JevRequest = {
  model: DEFAULT_JEV_MODEL,
  state: { a: 1 },
  questions: { q: { type: "noul", instructions: "yes?" } },
};

const OK_BODY = {
  model: "jev-1.13.0",
  answers: { q: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("askJev", () => {
  it("posts the request with the bearer key and returns the answers", async () => {
    const calls: { url: unknown; init?: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(OK_BODY);
    };
    const response = await askJev(REQUEST, { apiKey: "k", fetch: fetchFn });
    expect(response).toEqual(OK_BODY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEFAULT_JEV_URL);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer k",
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(REQUEST);
  });

  it("retries 429 and 529 with exponential backoff, then succeeds", async () => {
    const statuses = [429, 529, 200];
    const fetchFn: typeof fetch = async () => {
      const status = statuses.shift()!;
      return status === 200 ? jsonResponse(OK_BODY) : jsonResponse({}, status);
    };
    const sleeps: number[] = [];
    await askJev(REQUEST, {
      apiKey: "k",
      url: "http://jev.test",
      fetch: fetchFn,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([10, 20]);
  });

  it("gives up after the retry budget with the status and body", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response("slow down", { status: 429 });
    await expect(
      askJev(REQUEST, {
        apiKey: "k",
        fetch: fetchFn,
        retries: 0,
      }),
    ).rejects.toThrow("Jev request failed with HTTP 429: slow down");
  });

  it("does not retry other failures, and omits an empty body", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls++;
      return new Response("", { status: 401 });
    };
    await expect(
      askJev(REQUEST, { apiKey: "bad", fetch: fetchFn }),
    ).rejects.toThrow(/^Jev request failed with HTTP 401$/);
    expect(calls).toBe(1);
  });

  it("uses the default sleep between retries", async () => {
    const statuses = [529, 200];
    const fetchFn: typeof fetch = async () => {
      const status = statuses.shift()!;
      return status === 200 ? jsonResponse(OK_BODY) : jsonResponse({}, status);
    };
    await expect(
      askJev(REQUEST, { apiKey: "k", fetch: fetchFn, baseDelayMs: 1 }),
    ).resolves.toEqual(OK_BODY);
  });

  it("rejects a body that is not an answer set", async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ answers: 1 });
    await expect(
      askJev(REQUEST, { apiKey: "k", fetch: fetchFn }),
    ).rejects.toThrow("not a valid answer set");
  });

  it("falls back to the global fetch when none is injected", async () => {
    // With a proxy variable set, the proxy-aware fetch would be chosen instead;
    // clear them so this exercises the no-proxy default.
    const proxyKeys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ];
    const saved = proxyKeys.map((k) => [k, process.env[k]] as const);
    for (const k of proxyKeys) delete process.env[k];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(OK_BODY));
    try {
      await expect(askJev(REQUEST, { apiKey: "k" })).resolves.toEqual(OK_BODY);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });
});

describe("isJevResponse", () => {
  it("accepts noul and choice answers", () => {
    expect(
      isJevResponse({
        model: "m",
        answers: {
          a: { type: "noul", noul: 0 },
          b: {
            type: "choice",
            choice: "x",
            probabilities: { x: 1, y: 0 },
            confidence: 1,
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing model", { answers: {} }],
    ["non-object answers", { model: "m", answers: [] }],
    ["an answer that is not an object", { model: "m", answers: { a: 1 } }],
    [
      "a probability above 1",
      { model: "m", answers: { a: { type: "noul", noul: 2 } } },
    ],
    [
      "a non-numeric noul",
      { model: "m", answers: { a: { type: "noul", noul: "y" } } },
    ],
    [
      "a choice without a string winner",
      { model: "m", answers: { a: { type: "choice", probabilities: {} } } },
    ],
    [
      "a choice without probabilities",
      { model: "m", answers: { a: { type: "choice", choice: "x" } } },
    ],
    [
      "a choice with a bad probability",
      {
        model: "m",
        answers: {
          a: { type: "choice", choice: "x", probabilities: { x: -1 } },
        },
      },
    ],
    [
      "an unknown answer type",
      { model: "m", answers: { a: { type: "score" } } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(isJevResponse(value)).toBe(false);
  });
});

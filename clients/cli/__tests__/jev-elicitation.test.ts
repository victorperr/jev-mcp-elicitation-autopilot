// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
import { describe, it, expect } from "vitest";
import {
  ACTION_QUESTION,
  buildJevRequest,
  coerceOverride,
  decideElicitResult,
  fieldKey,
  parseRequestedSchema,
  type ElicitContext,
  type ElicitField,
} from "../src/elicit/jev-elicitation.js";
import type { JevAnswer, JevResponse } from "../src/elicit/jev-types.js";

const SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm", description: "Really?" },
    env: {
      type: "string",
      title: "Environment",
      enum: ["staging", "prod"],
      enumNames: ["Staging", "Production"],
    },
    region: {
      type: "string",
      oneOf: [
        { const: "eu", title: "Europe" },
        { const: "us", title: "United States" },
        { nope: true },
      ],
    },
    tags: {
      type: "array",
      items: { anyOf: [{ const: "a", title: "A" }, { const: "b" }] },
      minItems: 1,
      maxItems: 1,
      default: ["a"],
    },
    reason: { type: "string", default: "because" },
    count: { type: "integer" },
    ratio: { type: "number", default: 0.5 },
  },
  required: ["confirm", "env", "count", 42],
};

function fields(): ElicitField[] {
  return parseRequestedSchema(SCHEMA);
}

function ctx(overrides: Record<string, unknown> = {}): ElicitContext {
  return {
    message: "Delete the table?",
    fields: fields(),
    policy: "cautious",
    overrides: { count: 3, ...overrides },
  };
}

function choice(
  probabilities: Record<string, number>,
): Extract<JevAnswer, { type: "choice" }> {
  const [winner] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return {
    type: "choice",
    choice: winner![0],
    probabilities,
    confidence: winner![1],
  };
}

function noul(p: number): JevAnswer {
  return { type: "noul", noul: p };
}

/** A confident "accept" with every Jev-decided field answered. */
function acceptResponse(extra: Record<string, JevAnswer> = {}): JevResponse {
  return {
    model: "jev-1.13.0",
    answers: {
      [ACTION_QUESTION]: choice({ accept: 0.95, decline: 0.04, cancel: 0.01 }),
      [fieldKey(0)]: noul(0.9),
      [fieldKey(1)]: choice({ staging: 0.9, prod: 0.1 }),
      [fieldKey(2)]: choice({ eu: 0.85, us: 0.15 }),
      [fieldKey(3, 0)]: noul(0.92),
      [fieldKey(3, 1)]: noul(0.05),
      ...extra,
    },
  };
}

describe("parseRequestedSchema", () => {
  it("classifies every spec field shape", () => {
    const parsed = fields();
    expect(parsed.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["confirm", "boolean", true],
      ["env", "single", true],
      ["region", "single", false],
      ["tags", "multi", false],
      ["reason", "string", false],
      ["count", "number", true],
      ["ratio", "number", false],
    ]);
    expect(parsed[0]).toMatchObject({
      label: "Confirm",
      description: "Really?",
    });
    expect(parsed[1]).toMatchObject({
      options: [
        { value: "staging", label: "Staging" },
        { value: "prod", label: "Production" },
      ],
    });
    // Entries without a string `const` are dropped, not fatal.
    expect(parsed[2]).toMatchObject({
      options: [
        { value: "eu", label: "Europe" },
        { value: "us", label: "United States" },
      ],
    });
    expect(parsed[3]).toMatchObject({
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "b" },
      ],
      default: ["a"],
      minItems: 1,
      maxItems: 1,
    });
    expect(parsed[4]).toMatchObject({ default: "because" });
    expect(parsed[5]).toMatchObject({ integer: true });
    expect(parsed[6]).toMatchObject({ integer: false, default: 0.5 });
  });

  it("keeps defaults for single and boolean fields and reads items.oneOf / items.enum", () => {
    const parsed = parseRequestedSchema({
      properties: {
        pick: { type: "string", enum: ["x", 1], default: "x" },
        ok: { type: "boolean", default: false },
        many: { type: "array", items: { oneOf: [{ const: "m" }] } },
        list: { type: "array", items: { enum: ["p"] }, default: [1] },
      },
    });
    expect(parsed[0]).toMatchObject({
      kind: "single",
      options: [{ value: "x", label: "x" }],
      default: "x",
    });
    expect(parsed[1]).toMatchObject({ kind: "boolean", default: false });
    expect(parsed[2]).toMatchObject({ kind: "multi" });
    expect(parsed[3]).toMatchObject({ kind: "multi" });
    expect(parsed[3]).not.toHaveProperty("default");
  });

  it("marks anything outside the spec as unsupported", () => {
    const parsed = parseRequestedSchema({
      properties: {
        notAnObject: "string",
        object: { type: "object" },
        emptyEnum: { type: "array", items: { enum: [] } },
        noItems: { type: "array" },
        itemsWithoutOptions: { type: "array", items: { type: "string" } },
        emptyStringEnum: { type: "string", enum: [] },
      },
    });
    expect(parsed.map((f) => f.kind)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "string",
    ]);
    expect(parsed[0]).toMatchObject({ label: "notAnObject" });
  });

  it("returns no fields for a schema without properties", () => {
    expect(parseRequestedSchema(undefined)).toEqual([]);
    expect(parseRequestedSchema({ type: "object" })).toEqual([]);
    expect(parseRequestedSchema([])).toEqual([]);
  });
});

describe("coerceOverride", () => {
  const byName = (name: string) => fields().find((f) => f.name === name)!;

  it("accepts values of the field's type", () => {
    expect(coerceOverride(byName("env"), "prod")).toBe("prod");
    expect(coerceOverride(byName("tags"), "b")).toEqual(["b"]);
    expect(coerceOverride(byName("tags"), ["a", "b"])).toEqual(["a", "b"]);
    expect(coerceOverride(byName("confirm"), false)).toBe(false);
    expect(coerceOverride(byName("reason"), "why")).toBe("why");
    expect(coerceOverride(byName("reason"), 10001)).toBe("10001");
    expect(coerceOverride(byName("reason"), true)).toBe("true");
    expect(coerceOverride(byName("count"), 3)).toBe(3);
    expect(coerceOverride(byName("ratio"), 0.25)).toBe(0.25);
  });

  it("rejects mismatches, naming the field", () => {
    expect(() => coerceOverride(byName("env"), "dev")).toThrow(
      "--elicit-default env: expected one of staging, prod",
    );
    expect(() => coerceOverride(byName("env"), 1)).toThrow(/env/);
    expect(() => coerceOverride(byName("tags"), ["z"])).toThrow(/tags/);
    expect(() => coerceOverride(byName("tags"), 5)).toThrow(/tags/);
    expect(() => coerceOverride(byName("confirm"), "yes")).toThrow(
      /true or false/,
    );
    expect(() => coerceOverride(byName("reason"), ["x"])).toThrow(/a string/);
    expect(() => coerceOverride(byName("count"), "3")).toThrow(/a number/);
    expect(() => coerceOverride(byName("count"), 1.5)).toThrow(/an integer/);
  });

  it("passes primitives through for unsupported fields", () => {
    const [field] = parseRequestedSchema({
      properties: { x: { type: "null" } },
    });
    expect(coerceOverride(field!, "v")).toBe("v");
    expect(coerceOverride(field!, 2)).toBe(2);
    expect(coerceOverride(field!, true)).toBe(true);
    expect(() => coerceOverride(field!, { a: 1 })).toThrow(/string, number/);
  });
});

describe("buildJevRequest", () => {
  it("asks the action plus one question per decidable field", () => {
    const request = buildJevRequest(
      { ...ctx({ confirm: true }), toolCall: { name: "drop", arguments: {} } },
      "jev-latest",
    );
    expect(request.model).toBe("jev-latest");
    expect(request.state).toMatchObject({
      user_policy: "cautious",
      elicitation_message: "Delete the table?",
      triggered_by_tool_call: { name: "drop", arguments: {} },
    });
    expect(Object.keys(request.questions)).toEqual([
      ACTION_QUESTION,
      // f0 (confirm) is overridden, f4..f6 are text / number.
      fieldKey(1),
      fieldKey(2),
      fieldKey(3, 0),
      fieldKey(3, 1),
    ]);
    expect(request.questions[ACTION_QUESTION]).toMatchObject({
      type: "choice",
      criteria: {
        accept: expect.any(String),
        decline: expect.any(String),
        cancel: expect.any(String),
      },
    });
    expect(request.questions[fieldKey(1)]).toMatchObject({
      type: "choice",
      criteria: { staging: "Staging", prod: "Production" },
    });
    expect(request.questions[fieldKey(3, 1)]).toMatchObject({ type: "noul" });
  });

  it("asks boolean fields as nouls and omits the tool call when unknown", () => {
    const request = buildJevRequest(ctx(), "m");
    expect(request.questions[fieldKey(0)]).toMatchObject({
      type: "noul",
      instructions: expect.stringContaining('"Confirm" (Really?)'),
    });
    expect(request.state).not.toHaveProperty("triggered_by_tool_call");
  });
});

describe("decideElicitResult", () => {
  const opts = { threshold: 0.8 };

  it("accepts and fills every field from its source", () => {
    const decision = decideElicitResult(ctx(), acceptResponse(), opts);
    expect(decision.problems).toEqual([]);
    expect(decision.action).toEqual({ value: "accept", probability: 0.95 });
    expect(decision.result).toEqual({
      action: "accept",
      content: {
        confirm: true,
        env: "staging",
        region: "eu",
        tags: ["a"],
        reason: "because",
        count: 3,
        ratio: 0.5,
      },
    });
    expect(decision.fields.find((f) => f.field === "count")).toMatchObject({
      source: "override",
    });
    expect(decision.fields.find((f) => f.field === "reason")).toMatchObject({
      source: "schema-default",
    });
    expect(decision.fields.find((f) => f.field === "env")).toMatchObject({
      source: "jev",
      probability: 0.9,
    });
  });

  it("answers a false noul as an unticked checkbox", () => {
    const decision = decideElicitResult(
      ctx(),
      acceptResponse({ [fieldKey(0)]: noul(0.1) }),
      opts,
    );
    expect(decision.result?.content?.confirm).toBe(false);
  });

  it("passes a confident decline or cancel straight through", () => {
    for (const action of ["decline", "cancel"] as const) {
      const decision = decideElicitResult(
        ctx(),
        {
          model: "m",
          answers: {
            [ACTION_QUESTION]: choice({ accept: 0.05, [action]: 0.95 }),
          },
        },
        opts,
      );
      expect(decision.result).toEqual({ action });
      expect(decision.fields).toEqual([]);
    }
  });

  it("reports an action below the threshold as ambiguous", () => {
    const decision = decideElicitResult(
      ctx(),
      {
        model: "m",
        answers: {
          [ACTION_QUESTION]: choice({
            accept: 0.55,
            decline: 0.4,
            cancel: 0.05,
          }),
        },
      },
      opts,
    );
    expect(decision.result).toBeUndefined();
    expect(decision.problems).toEqual([
      {
        kind: "ambiguous",
        message: "action: accept 0.55 / decline 0.4 is below the 0.8 threshold",
      },
    ]);
  });

  it("reports ambiguous single, boolean and multi-select answers", () => {
    const decision = decideElicitResult(
      ctx(),
      acceptResponse({
        [fieldKey(0)]: noul(0.5),
        [fieldKey(1)]: choice({ staging: 0.6, prod: 0.4 }),
        [fieldKey(3, 1)]: noul(0.4),
      }),
      opts,
    );
    expect(decision.result).toBeUndefined();
    expect(decision.problems.map((p) => p.message)).toEqual([
      "confirm: p(yes)=0.5 is inside the ambiguous band",
      "env: staging 0.6 / prod 0.4 is below the 0.8 threshold",
      'tags: option "b" p(yes)=0.4 is inside the ambiguous band',
    ]);
  });

  it("rejects a multi-select that breaks the field's item bounds", () => {
    const tooMany = decideElicitResult(
      ctx(),
      acceptResponse({ [fieldKey(3, 1)]: noul(0.99) }),
      opts,
    );
    expect(tooMany.problems[0]?.message).toBe(
      "tags: 2 option(s) selected, outside the field's 1..1 bounds",
    );
    const none = decideElicitResult(
      ctx(),
      acceptResponse({ [fieldKey(3, 0)]: noul(0.01) }),
      opts,
    );
    expect(none.problems[0]?.message).toContain("0 option(s)");
  });

  it("describes open bounds when only one side is set", () => {
    const [field] = parseRequestedSchema({
      properties: {
        t: { type: "array", items: { enum: ["a", "b"] }, maxItems: 1 },
      },
    });
    const decision = decideElicitResult(
      { message: "m", fields: [field!], policy: "p", overrides: {} },
      {
        model: "m",
        answers: {
          [ACTION_QUESTION]: choice({ accept: 1 }),
          [fieldKey(0, 0)]: noul(1),
          [fieldKey(0, 1)]: noul(1),
        },
      },
      opts,
    );
    expect(decision.problems[0]?.message).toContain("0..1 bounds");
    const [minOnly] = parseRequestedSchema({
      properties: {
        t: { type: "array", items: { enum: ["a"] }, minItems: 2 },
      },
    });
    const short = decideElicitResult(
      { message: "m", fields: [minOnly!], policy: "p", overrides: {} },
      {
        model: "m",
        answers: {
          [ACTION_QUESTION]: choice({ accept: 1 }),
          [fieldKey(0, 0)]: noul(1),
        },
      },
      opts,
    );
    expect(short.problems[0]?.message).toContain("2..∞ bounds");
  });

  it("reports a required text field with no value as unfilled", () => {
    const decision = decideElicitResult(
      { ...ctx(), overrides: {} },
      acceptResponse(),
      opts,
    );
    expect(decision.problems).toEqual([
      {
        kind: "unfilled",
        message:
          "count: required number field has no value; pass --elicit-default count=<value>",
      },
    ]);
  });

  it("leaves an optional field with no value out of the content", () => {
    const [field] = parseRequestedSchema({
      properties: { note: { type: "string" } },
    });
    const decision = decideElicitResult(
      { message: "m", fields: [field!], policy: "p", overrides: {} },
      undefined,
      opts,
    );
    expect(decision.result).toEqual({ action: "accept", content: {} });
    expect(decision.fields).toEqual([{ field: "note", source: "unset" }]);
  });

  it("accepts from defaults alone when there is no Jev response", () => {
    const decision = decideElicitResult(
      ctx({ confirm: true, env: "prod" }),
      undefined,
      opts,
    );
    expect(decision.action).toEqual({ value: "accept" });
    expect(decision.result?.content).toMatchObject({
      confirm: true,
      env: "prod",
      tags: ["a"],
      count: 3,
    });
    // `region` has no default and is optional, so it stays unset.
    expect(decision.result?.content).not.toHaveProperty("region");
  });

  it("throws on a response missing an answer or naming an unknown action", () => {
    expect(() =>
      decideElicitResult(ctx(), { model: "m", answers: {} }, opts),
    ).toThrow('Jev response has no choice answer for question "action".');
    expect(() =>
      decideElicitResult(
        ctx(),
        { model: "m", answers: { [ACTION_QUESTION]: choice({ maybe: 1 }) } },
        opts,
      ),
    ).toThrow('Jev chose an unknown action "maybe".');
    expect(() =>
      decideElicitResult(
        ctx(),
        acceptResponse({ [fieldKey(1)]: noul(1) }),
        opts,
      ),
    ).toThrow('no choice answer for question "f1"');
  });

  it("treats a winner missing from its own distribution as probability 0", () => {
    const decision = decideElicitResult(
      ctx(),
      {
        model: "m",
        answers: {
          [ACTION_QUESTION]: {
            type: "choice",
            choice: "accept",
            probabilities: {},
            confidence: 0,
          },
        },
      },
      opts,
    );
    expect(decision.problems[0]?.kind).toBe("ambiguous");
    const field = decideElicitResult(
      ctx(),
      acceptResponse({
        [fieldKey(1)]: {
          type: "choice",
          choice: "staging",
          probabilities: {},
          confidence: 0,
        },
      }),
      opts,
    );
    expect(field.problems[0]?.message).toContain("env:");
  });
});

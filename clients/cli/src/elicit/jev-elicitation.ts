// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Pure mapping between an MCP form elicitation and a Jev decision request.
 *
 * MCP restricts a form elicitation's `requestedSchema` to a flat object of
 * primitive fields, and most of those fields are decisions rather than text:
 * a single-select enum is a Jev `choice`, a boolean is a Jev `noul`, and a
 * multi-select enum is one `noul` per option. Jev cannot write, so free text
 * and numbers are never asked — they come from `--elicit-default` or the
 * schema's own `default`, and a required one with neither is reported rather
 * than guessed.
 *
 * On top of the fields, Jev is asked whether the simulated user responds at
 * all (`accept` / `decline` / `cancel`), judged against a plain-English
 * policy. That is what lets one CLI invocation exercise the "user said no"
 * branch of a server, which no other unattended client reaches.
 *
 * Every probability is held to a threshold instead of taking the argmax: Jev
 * cannot abstain, so an answer below the bar is surfaced as ambiguous rather
 * than acted on — and an ambiguous form is itself a finding about the server.
 *
 * Nothing here does I/O, so the whole decision is unit-testable from fixtures;
 * the HTTP call and the InspectorClient wiring live in their own modules.
 */
import type { JevAnswer, JevRequest, JevResponse } from "./jev-types.js";

/** A value an elicitation form field can hold, per the MCP spec. */
export type ElicitValue = string | number | boolean | string[];

export interface EnumOption {
  value: string;
  label: string;
}

interface FieldBase {
  name: string;
  label: string;
  description?: string;
  required: boolean;
}

export type ElicitField =
  | (FieldBase & { kind: "single"; options: EnumOption[]; default?: string })
  | (FieldBase & {
      kind: "multi";
      options: EnumOption[];
      default?: string[];
      minItems?: number;
      maxItems?: number;
    })
  | (FieldBase & { kind: "boolean"; default?: boolean })
  | (FieldBase & { kind: "string"; default?: string })
  | (FieldBase & { kind: "number"; integer: boolean; default?: number })
  | (FieldBase & { kind: "unsupported"; default?: ElicitValue });

export type ElicitAction = "accept" | "decline" | "cancel";

/**
 * The subset of an MCP `ElicitResult` the autopilot produces. A type alias
 * rather than an interface: the SDK's result type carries an index signature,
 * which an alias satisfies implicitly and an interface does not.
 */
export type AutopilotResult = {
  action: ElicitAction;
  content?: Record<string, ElicitValue>;
};

export const ACTION_QUESTION = "action";

/** Used when `--elicit-policy` is not given. */
export const DEFAULT_POLICY =
  "A reasonable user who wants the task they started to complete, and who does not approve anything destructive or irreversible unless the task plainly asked for it.";

const ACTION_CRITERIA: Record<ElicitAction, string> = {
  accept:
    "Fills in the form and submits it: the user agrees to what the server asks, or is willing to provide the information",
  decline:
    "Explicitly refuses: the user does not want this to happen, or will not provide the information",
  cancel: "Dismisses the request without making any decision",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Read enum options from either spelling the spec allows: `enum` (+ the
 * legacy parallel `enumNames` labels), or a `oneOf` / `anyOf` list of
 * `{ const, title }` entries.
 */
function readOptions(schema: Record<string, unknown>): EnumOption[] | null {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    const values = schema.enum.filter(
      (v): v is string => typeof v === "string",
    );
    return values.map((value, i) => ({
      value,
      label: optionalString(names[i]) ?? value,
    }));
  }
  const list = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (!list) return null;
  const options: EnumOption[] = [];
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.const === "string") {
      options.push({
        value: entry.const,
        label: optionalString(entry.title) ?? entry.const,
      });
    }
  }
  return options;
}

function parseField(
  name: string,
  schema: unknown,
  required: boolean,
): ElicitField {
  const base: FieldBase = { name, label: name, required };
  if (!isRecord(schema)) return { ...base, kind: "unsupported" };
  base.label = optionalString(schema.title) ?? name;
  const description = optionalString(schema.description);
  if (description) base.description = description;
  const def = schema.default;

  if (schema.type === "string") {
    const options = readOptions(schema);
    if (options && options.length > 0) {
      return {
        ...base,
        kind: "single",
        options,
        ...(typeof def === "string" && { default: def }),
      };
    }
    return {
      ...base,
      kind: "string",
      ...(typeof def === "string" && { default: def }),
    };
  }
  if (schema.type === "boolean") {
    return {
      ...base,
      kind: "boolean",
      ...(typeof def === "boolean" && { default: def }),
    };
  }
  if (schema.type === "number" || schema.type === "integer") {
    return {
      ...base,
      kind: "number",
      integer: schema.type === "integer",
      ...(typeof def === "number" && { default: def }),
    };
  }
  if (schema.type === "array" && isRecord(schema.items)) {
    const options = readOptions(schema.items);
    if (options && options.length > 0) {
      return {
        ...base,
        kind: "multi",
        options,
        ...(Array.isArray(def) &&
          def.every((v) => typeof v === "string") && {
            default: def as string[],
          }),
        ...(typeof schema.minItems === "number" && {
          minItems: schema.minItems,
        }),
        ...(typeof schema.maxItems === "number" && {
          maxItems: schema.maxItems,
        }),
      };
    }
  }
  return { ...base, kind: "unsupported" };
}

/**
 * Parse an untrusted `requestedSchema` into fields. A server can send
 * anything, so every property is narrowed individually and one the spec does
 * not allow becomes `unsupported` rather than failing the whole form.
 */
export function parseRequestedSchema(schema: unknown): ElicitField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  return Object.entries(schema.properties).map(([name, prop]) =>
    parseField(name, prop, required.has(name)),
  );
}

/**
 * Coerce a `--elicit-default` value (already JSON-parsed by the CLI's
 * key=value parser) to the field's type. The parser turns `zip=10001` into a
 * number, so a string field accepts numbers and booleans as their text; every
 * other mismatch throws, naming the field, since sending it would only move
 * the failure to the server.
 */
export function coerceOverride(
  field: ElicitField,
  value: unknown,
): ElicitValue {
  const fail = (expected: string): never => {
    throw new Error(
      `--elicit-default ${field.name}: expected ${expected}, got ${JSON.stringify(value)}.`,
    );
  };
  const optionValues = (): string[] =>
    field.kind === "single" || field.kind === "multi"
      ? field.options.map((o) => o.value)
      : [];

  switch (field.kind) {
    case "single":
      if (typeof value !== "string" || !optionValues().includes(value)) {
        return fail(`one of ${optionValues().join(", ")}`);
      }
      return value;
    case "multi": {
      const list = typeof value === "string" ? [value] : value;
      if (
        !Array.isArray(list) ||
        !list.every(
          (v): v is string =>
            typeof v === "string" && optionValues().includes(v),
        )
      ) {
        return fail(`a list drawn from ${optionValues().join(", ")}`);
      }
      return list;
    }
    case "boolean":
      if (typeof value !== "boolean") return fail("true or false");
      return value;
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return fail("a string");
    case "number":
      if (typeof value !== "number") return fail("a number");
      if (field.integer && !Number.isInteger(value)) return fail("an integer");
      return value;
    case "unsupported":
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return value;
      }
      return fail("a string, number or boolean");
  }
}

/** Question key for field `i`, and for option `j` of a multi-select field. */
export function fieldKey(i: number, j?: number): string {
  return j === undefined ? `f${i}` : `f${i}_o${j}`;
}

/** Whether Jev decides this field, i.e. it is not text and not overridden. */
function jevDecides(
  field: ElicitField,
  overrides: Record<string, unknown>,
): boolean {
  if (Object.hasOwn(overrides, field.name)) return false;
  return (
    field.kind === "single" ||
    field.kind === "multi" ||
    field.kind === "boolean"
  );
}

function fieldPhrase(field: ElicitField): string {
  const desc = field.description ? ` (${field.description})` : "";
  return `"${field.label}"${desc}`;
}

export interface ElicitContext {
  message: string;
  fields: ElicitField[];
  policy: string;
  /** The call that triggered the elicitation, when the CLI knows it. */
  toolCall?: { name: string; arguments?: Record<string, unknown> };
  /** `--elicit-default` values, keyed by field name (not yet coerced). */
  overrides: Record<string, unknown>;
}

/**
 * Build one Jev request for the whole elicitation: the action question plus
 * one question per decidable field. Jev answers every question in isolation
 * against the same state, so asking the field questions speculatively (before
 * knowing the user accepts) costs only their own tokens and cannot bias the
 * action answer.
 */
export function buildJevRequest(ctx: ElicitContext, model: string): JevRequest {
  const state: Record<string, unknown> = {
    user_policy: ctx.policy,
    elicitation_message: ctx.message,
    form_fields: ctx.fields.map((f) => ({
      name: f.name,
      label: f.label,
      ...(f.description && { description: f.description }),
      kind: f.kind,
      required: f.required,
      ...((f.kind === "single" || f.kind === "multi") && {
        options: f.options.map((o) => o.label),
      }),
    })),
  };
  if (ctx.toolCall) state.triggered_by_tool_call = ctx.toolCall;

  const questions: JevRequest["questions"] = {
    [ACTION_QUESTION]: {
      type: "choice",
      instructions:
        "The server shows the user `elicitation_message` together with the form described by `form_fields`. Acting as the user described by `user_policy`, how does the user respond?",
      criteria: { ...ACTION_CRITERIA },
    },
  };

  ctx.fields.forEach((field, i) => {
    if (!jevDecides(field, ctx.overrides)) return;
    const lead =
      "Assume the user described by `user_policy` accepted `elicitation_message` and is filling in the form.";
    if (field.kind === "single") {
      questions[fieldKey(i)] = {
        type: "choice",
        instructions: `${lead} Which option do they select for the field ${fieldPhrase(field)}?`,
        criteria: Object.fromEntries(
          field.options.map((o) => [o.value, o.label]),
        ),
      };
    } else if (field.kind === "boolean") {
      questions[fieldKey(i)] = {
        type: "noul",
        instructions: `${lead} Do they tick the checkbox ${fieldPhrase(field)}?`,
      };
    } else if (field.kind === "multi") {
      field.options.forEach((option, j) => {
        questions[fieldKey(i, j)] = {
          type: "noul",
          instructions: `${lead} In the multi-select field ${fieldPhrase(field)}, do they select the option "${option.label}"?`,
        };
      });
    }
  });

  return { model, state, questions };
}

/** How one field got its value, for the transcript line. */
export interface FieldTrace {
  field: string;
  source: "override" | "jev" | "schema-default" | "unset";
  value?: ElicitValue;
  /** Probability behind a Jev decision (the winner's, or yes for a noul). */
  probability?: number;
}

export interface Problem {
  kind: "ambiguous" | "unfilled";
  message: string;
}

export interface ElicitDecision {
  /** Absent when any {@link problems} were found. */
  result?: AutopilotResult;
  action?: { value: ElicitAction; probability?: number };
  fields: FieldTrace[];
  problems: Problem[];
}

function round(p: number): number {
  return Math.round(p * 100) / 100;
}

function answerOf<T extends JevAnswer["type"]>(
  response: JevResponse,
  key: string,
  type: T,
): Extract<JevAnswer, { type: T }> {
  const answer = response.answers[key];
  if (!answer || answer.type !== type) {
    throw new Error(
      `Jev response has no ${type} answer for question "${key}".`,
    );
  }
  return answer as Extract<JevAnswer, { type: T }>;
}

/** Top two entries of a choice distribution, for an ambiguity message. */
function describeDistribution(probabilities: Record<string, number>): string {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, p]) => `${k} ${round(p)}`)
    .join(" / ");
}

/**
 * Decide a noul against the threshold band: yes at `p >= t`, no at
 * `p <= 1 - t`, and ambiguous in between.
 */
function decideNoul(p: number, threshold: number): boolean | undefined {
  if (p >= threshold) return true;
  if (p <= 1 - threshold) return false;
  return undefined;
}

export interface DecideOptions {
  /** Minimum probability for any answer to be acted on, in (0.5, 1]. */
  threshold: number;
}

/**
 * Turn Jev's answers into the result to send back to the server.
 *
 * `response` is `undefined` in `--elicit defaults` mode: the user accepts and
 * every field comes from an override or the schema's default.
 */
export function decideElicitResult(
  ctx: ElicitContext,
  response: JevResponse | undefined,
  options: DecideOptions,
): ElicitDecision {
  const { threshold } = options;
  const decision: ElicitDecision = { fields: [], problems: [] };

  let action: ElicitAction = "accept";
  if (response) {
    const answer = answerOf(response, ACTION_QUESTION, "choice");
    const p = answer.probabilities[answer.choice] ?? 0;
    if (!(answer.choice in ACTION_CRITERIA)) {
      throw new Error(`Jev chose an unknown action "${answer.choice}".`);
    }
    action = answer.choice as ElicitAction;
    decision.action = { value: action, probability: round(p) };
    if (p < threshold) {
      decision.problems.push({
        kind: "ambiguous",
        message: `action: ${describeDistribution(answer.probabilities)} is below the ${threshold} threshold`,
      });
      return decision;
    }
  } else {
    decision.action = { value: "accept" };
  }

  if (action !== "accept") {
    decision.result = { action };
    return decision;
  }

  const content: Record<string, ElicitValue> = {};
  ctx.fields.forEach((field, i) => {
    const trace: FieldTrace = { field: field.name, source: "unset" };
    decision.fields.push(trace);
    const set = (value: ElicitValue, source: FieldTrace["source"]) => {
      content[field.name] = value;
      trace.value = value;
      trace.source = source;
    };

    if (Object.hasOwn(ctx.overrides, field.name)) {
      set(coerceOverride(field, ctx.overrides[field.name]), "override");
      return;
    }

    if (response && field.kind === "single") {
      const answer = answerOf(response, fieldKey(i), "choice");
      const p = answer.probabilities[answer.choice] ?? 0;
      trace.probability = round(p);
      if (p >= threshold) set(answer.choice, "jev");
      else {
        decision.problems.push({
          kind: "ambiguous",
          message: `${field.name}: ${describeDistribution(answer.probabilities)} is below the ${threshold} threshold`,
        });
      }
      return;
    }

    if (response && field.kind === "boolean") {
      const p = answerOf(response, fieldKey(i), "noul").noul;
      trace.probability = round(p);
      const yes = decideNoul(p, threshold);
      if (yes === undefined) {
        decision.problems.push({
          kind: "ambiguous",
          message: `${field.name}: p(yes)=${round(p)} is inside the ambiguous band`,
        });
      } else set(yes, "jev");
      return;
    }

    if (response && field.kind === "multi") {
      const selected: string[] = [];
      let unsure = false;
      field.options.forEach((option, j) => {
        const p = answerOf(response, fieldKey(i, j), "noul").noul;
        const yes = decideNoul(p, threshold);
        if (yes === undefined) {
          unsure = true;
          decision.problems.push({
            kind: "ambiguous",
            message: `${field.name}: option "${option.value}" p(yes)=${round(p)} is inside the ambiguous band`,
          });
        } else if (yes) selected.push(option.value);
      });
      if (unsure) return;
      if (
        (field.minItems !== undefined && selected.length < field.minItems) ||
        (field.maxItems !== undefined && selected.length > field.maxItems)
      ) {
        decision.problems.push({
          kind: "ambiguous",
          message: `${field.name}: ${selected.length} option(s) selected, outside the field's ${field.minItems ?? 0}..${field.maxItems ?? "∞"} bounds`,
        });
        return;
      }
      set(selected, "jev");
      return;
    }

    if (field.default !== undefined) {
      set(field.default, "schema-default");
      return;
    }
    if (field.required) {
      decision.problems.push({
        kind: "unfilled",
        message: `${field.name}: required ${field.kind} field has no value; pass --elicit-default ${field.name}=<value>`,
      });
    }
  });

  if (decision.problems.length === 0) {
    decision.result = { action: "accept", content };
  }
  return decision;
}

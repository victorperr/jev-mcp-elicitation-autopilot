// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Wire types for TypeSafe's Jev decision API (`POST /v1/systemone`), limited
 * to the two question types the elicitation autopilot asks: `noul` (yes/no,
 * answered with the probability of yes) and `choice` (one option out of a
 * named set, answered with the full distribution).
 *
 * Kept in their own file so the pure mapping (`jev-elicitation.ts`) and the
 * HTTP client (`jev-client.ts`) share one definition without either importing
 * the other's runtime. Shapes follow https://docs.typesafe.ai/api.
 */

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name → description. Jev accepts up to 255 options. */
  criteria: Record<string, string>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

export interface JevNoulAnswer {
  type: "noul";
  /** Probability, 0..1, that the answer is yes. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isJevAnswer(value: unknown): value is JevAnswer {
  if (!isRecord(value)) return false;
  if (value.type === "noul") return isProbability(value.noul);
  if (value.type === "choice") {
    return (
      typeof value.choice === "string" &&
      isRecord(value.probabilities) &&
      Object.values(value.probabilities).every(isProbability)
    );
  }
  return false;
}

/**
 * Narrow an untrusted JSON body (the API's response, or a recording read back
 * from disk) to a {@link JevResponse}. Every answer is checked, since a
 * malformed one would otherwise surface much later as a wrong elicitation
 * answer rather than here as a clear error.
 */
export function isJevResponse(value: unknown): value is JevResponse {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    isRecord(value.answers) &&
    Object.values(value.answers).every(isJevAnswer)
  );
}

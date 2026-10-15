import { CHAT_TOOL_OUTPUT_BUDGET } from "../shared/chat";

/** Maximum serialized size of a single tool result handed to the model. */
export const CHAT_TOOL_RESULT_MAX = 24_000;
/** Maximum number of tool calls in one chat turn. */
export const CHAT_TOOL_CALL_MAX = 16;

/** Tool failures whose message is safe and actionable enough to show the model verbatim. */
const USER_VISIBLE_TOOL_ERROR = /^(Native browser draft saves|Select an authorized API|This draft cannot|This action is too large|Review at least|Gmail handoff|Provide sheets|Choose a valid file name|Too many files|Documents can only)/;

const count = (value: number) => value.toLocaleString("en-US");

export type ToolAdmission =
  | { kind: "accepted"; result: unknown }
  | { kind: "withheld"; result: { error: string; executed: false; budgetExhausted?: true } };

/**
 * Tracks how much tool output one chat turn has consumed. Oversized or over-budget results are withheld
 * rather than failing the turn, so the model can narrow its request or answer from evidence it already has.
 */
export class ToolOutputBudget {
  private used = 0;
  constructor(private readonly total = CHAT_TOOL_OUTPUT_BUDGET, private readonly perResult = CHAT_TOOL_RESULT_MAX) {}

  admit(result: unknown): ToolAdmission {
    const length = JSON.stringify(result)?.length ?? 0;
    if (length > this.perResult)
      return { kind: "withheld", result: { error: `This result is too large (${count(length)} characters; limit ${count(this.perResult)} per tool response). Request a smaller page, limit or single message.`, executed: false } };
    if (this.used + length > this.total)
      return { kind: "withheld", result: { error: `Evidence budget for this answer is used up (${count(this.total)} characters of tool output). Do not call more evidence tools. Answer now from the evidence already gathered, cite only messages you have read, and state that coverage was limited.`, budgetExhausted: true, executed: false } };
    this.used += length;
    return { kind: "accepted", result };
  }
}

/** Maps a tool exception to the model-facing error, hiding internal details unless the message is known to be safe. */
export function toolErrorResult(error: unknown): { error: string; executed?: false } {
  if (error instanceof Error && USER_VISIBLE_TOOL_ERROR.test(error.message)) return { error: error.message, executed: false };
  return { error: "The request is invalid, unavailable, too large, or outside permitted sources. Check the tool's schema and use a smaller page. No action was executed." };
}

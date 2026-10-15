import { describe, expect, it } from "vitest";
import { ToolOutputBudget, toolErrorResult } from "../src/main/chat-tool-budget";

describe("chat tool output budget", () => {
  it("accepts results until the cumulative budget is used, then withholds without failing", () => {
    const budget = new ToolOutputBudget(100, 60);
    const small = { text: "x".repeat(30) };
    expect(budget.admit(small)).toEqual({ kind: "accepted", result: small });
    expect(budget.admit(small)).toEqual({ kind: "accepted", result: small });
    const third = budget.admit(small);
    expect(third.kind).toBe("withheld");
    expect(third.result).toMatchObject({ budgetExhausted: true, executed: false });
  });

  it("withholds a single oversized result without consuming the budget", () => {
    const budget = new ToolOutputBudget(1000, 50);
    const large = budget.admit({ text: "x".repeat(80) });
    expect(large.kind).toBe("withheld");
    expect(large.result).toMatchObject({ executed: false });
    expect((large.result as { budgetExhausted?: boolean }).budgetExhausted).toBeUndefined();
    expect(budget.admit({ ok: true }).kind).toBe("accepted");
  });

  it("only exposes allow-listed tool error messages", () => {
    expect(toolErrorResult(new Error("Choose a valid file name ending in .docx"))).toEqual({ error: "Choose a valid file name ending in .docx", executed: false });
    expect(toolErrorResult(new Error("SQLITE internal path C:\\secret")).error).not.toContain("secret");
    expect(toolErrorResult("boom").error).toMatch(/No action was executed/);
  });
});

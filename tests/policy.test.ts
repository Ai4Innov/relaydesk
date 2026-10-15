import { describe, expect, it } from "vitest";
import { commandSchema } from "../src/main/ipc/schema";
import { proposeChange, validateApproval } from "../src/main/approvals";
import type { EventChange } from "../src/shared/contracts";

const change: EventChange = {
  accountId: "a", sourceId: "s", title: "Design review",
  start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z",
  timeZone: "Europe/Paris", allDay: false, attendees: ["reviewer@example.com"], location: "", description: ""
};
describe("privileged command boundary", () => {
  it("does not permit send, delete or shell commands", () => {
    for (const type of ["email.send", "slack.post", "calendar.delete", "shell", "sql"])
      expect(commandSchema.safeParse({ type }).success).toBe(false);
  });
  it("rejects quota counter tampering and injected properties", () => {
    expect(commandSchema.safeParse({ type: "settings.update", patch: { aiRunsToday: 0 } }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "sync", url: "https://example.com" }).success).toBe(false);
  });
  it("binds calendar approval to exact contents", () => {
    const approval = proposeChange(change);
    expect(() => validateApproval(approval, approval.hash)).not.toThrow();
    approval.change = { ...change, attendees: ["another@example.com"] };
    expect(() => validateApproval(approval, approval.hash)).toThrow("changed");
  });
  it("invalidates calendar approval when the reminder changes", () => {
    const approval = proposeChange(change);
    approval.change = { ...change, reminderMinutes: 5 };
    expect(() => validateApproval(approval, approval.hash)).toThrow("changed");
  });
  it("rejects reused approvals and invalid times", () => {
    const approval = proposeChange(change);
    approval.status = "done";
    expect(() => validateApproval(approval, approval.hash)).toThrow("no longer pending");
    expect(() => proposeChange({ ...change, end: change.start })).toThrow("end");
    expect(() => proposeChange({ ...change, timeZone: "Mars" })).toThrow("time zone");
    expect(() => proposeChange({ ...change, reminderMinutes: 40321 })).toThrow("Reminder");
  });
});

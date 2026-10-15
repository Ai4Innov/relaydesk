import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/App";
import { commandError, draftSignature, eventChange, fileSize, nativeDraftSupport, splitAddresses, validateEvent } from "../src/renderer/utils";
import type { Account, CalendarEvent, EventChange, Message } from "../src/shared/contracts";

const proposal: EventChange = { accountId: "account", sourceId: "calendar", title: "Review", start: "2026-10-02T08:00:00Z", end: "2026-10-02T09:00:00Z", timeZone: "Europe/Paris", allDay: false, attendees: [], location: "", description: "" };

describe("renderer boundary", () => {
  it("shows actionable command failures without Electron transport boilerplate", () => {
    expect(commandError(new Error("Error invoking remote method 'relay:command': Error: Gmail could not load."))).toBe("Gmail could not load.");
    expect(commandError(new Error("An ordinary error: details"))).toBe("An ordinary error: details");
    expect(commandError(null)).toBe("The action failed. Please try again.");
  });
  it("explains desktop requirement without faking success or demo data", () => {
    const html = renderToStaticMarkup(<App/>);
    expect(html).toContain("needs its desktop app");
    expect(html).toContain("does not simulate a connection");
    expect(html).not.toContain("Synthetic demo");
  });
  it("retains the complete calendar edit payload", () => {
    const event: CalendarEvent = { ...proposal, id: "event", providerId: "remote", revision: "revision", url: "", writable: true };
    expect(eventChange(event)).toEqual({ ...proposal, eventId: "event", expectedRevision: "revision" });
    expect(eventChange({ ...event, reminderMinutes: 15 }).reminderMinutes).toBe(15);
  });
  it("rejects invalid calendar ranges and accepts exclusive all-day ranges", () => {
    expect(validateEvent(proposal)).toBeUndefined();
    expect(validateEvent({ ...proposal, end: proposal.start })).toBe("End must be after start.");
    expect(validateEvent({ ...proposal, sourceId: "" })).toContain("calendar");
    expect(validateEvent({ ...proposal, timeZone: "Not/AZone" })).toContain("time zone");
    expect(validateEvent({ ...proposal, allDay: true, start: "2026-10-02", end: "2026-10-03" })).toBeUndefined();
    expect(validateEvent({ ...proposal, allDay: true })).toContain("calendar dates");
    expect(validateEvent({ ...proposal, start: "2026-10-02T08:00" })).toContain("UTC offset");
    expect(validateEvent({ ...proposal, attendees: ["not an address"] })).toContain("email addresses");
    expect(validateEvent({ ...proposal, reminderMinutes: -1 })).toContain("Reminder");
    expect(validateEvent({ ...proposal, reminderMinutes: 0 })).toBeUndefined();
  });
  it("includes every editable draft field in change detection", () => {
    const draft = { body: "Hello", subject: "Review", recipients: ["a@example.com"] };
    expect(draftSignature(draft)).not.toBe(draftSignature({ ...draft, body: "Edited" }));
    expect(draftSignature(draft)).not.toBe(draftSignature({ ...draft, recipients: ["b@example.com"] }));
    expect(draftSignature(draft)).not.toBe(draftSignature({ ...draft, subject: "Updated" }));
  });
  it("normalizes recipient input without inventing addresses", () => {
    expect(splitAddresses(" a@example.com; b@example.com,\n ")).toEqual(["a@example.com", "b@example.com"]);
    expect(splitAddresses("")).toEqual([]);
  });
  it("distinguishes unknown file sizes", () => {
    expect(fileSize()).toBe("Size unknown");
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(26 * 1024 * 1024)).toBe("26.0 MB");
  });
  it("only enables native Gmail draft saves for browser captures when the same email has API authorization", () => {
    const browserAccount: Account = { id: "browser:google:me@example.com", provider: "gmail", name: "Browser", email: "me@example.com", status: "connected", consent: true, aiEnabled: true, connection: "browser" };
    const apiAccount: Account = { id: "gmail:me@example.com", provider: "gmail", name: "API", email: "me@example.com", status: "connected", consent: true, aiEnabled: false };
    const message: Message = { id: "m", accountId: browserAccount.id, sourceId: `${browserAccount.id}:mail`, providerId: "thread:legacy", threadId: `${browserAccount.id}:thread:legacy`,
      subject: "Review", sender: "a@example.com", recipients: [], body: "Please review", receivedAt: "", url: "", unread: true, revision: "1", historical: true,
      browser: { completeness: "preview", capturedAt: "2026-09-22T10:00:00Z", dateText: "Yesterday" } };
    expect(nativeDraftSupport(message, [browserAccount]).enabled).toBe(false);
    expect(nativeDraftSupport(message, [browserAccount]).note).toContain("same Gmail address");
    expect(nativeDraftSupport(message, [browserAccount, apiAccount]).enabled).toBe(true);
    expect(nativeDraftSupport(message, [browserAccount, apiAccount]).note).toContain("same-email Gmail API");
  });
});

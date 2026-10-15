import { describe, expect, it } from "vitest";
import { inboxLabel, compareRecentMessages, inboxConversations, messageReceivedAt } from "../src/shared/inbox";
import { mailboxDate } from "../src/shared/mail-date";
import { demoData } from "../src/main/demo";

describe("inbox identity and recency", () => {
  it("distinguishes same-name accounts and browser/API connections", () => {
    const account = demoData().accounts[0];
    expect(inboxLabel({ ...account, demo: false, connection: "browser" })).toBe("alex@example.com - Gmail (browser)");
    expect(inboxLabel({ ...account, demo: false, connection: "api" })).toBe("alex@example.com - Gmail (API)");
    expect(inboxLabel({ ...account, email: "other@example.com" })).toContain("other@example.com");
  });
  it("never treats recent capture time as reception time and puts unknown dates last", () => {
    const message = demoData().messages[0];
    const recent = { ...message, id: "new", receivedAt: "", browser: {
      completeness: "preview" as const, capturedAt: "2026-09-22T14:00:00Z", dateText: "Today", position: 0
    } };
    const second = { ...recent, id: "second", browser: { ...recent.browser, position: 1 } };
    const old = { ...message, id: "old", receivedAt: "2026-09-21T14:00:00Z" };
    expect([old, second, recent].sort(compareRecentMessages).map(item => item.id)).toEqual(["old", "new", "second"]);
    expect(recent.receivedAt).toBe("");
  });
  it("parses absolute Gmail tooltips including narrow spaces, French dates, AM/PM and explicit zones", () => {
    expect(mailboxDate("Wed, Sep 23, 2026, 5:10\u202fPM")).toBe(new Date(2026, 8, 23, 17, 10).toISOString());
    expect(mailboxDate("Sep 23, 2026, 12:00 AM")).toBe(new Date(2026, 8, 23, 0).toISOString());
    expect(mailboxDate("Sep 23, 2026, 12:00 PM")).toBe(new Date(2026, 8, 23, 12).toISOString());
    expect(mailboxDate("mer. 23 sept. 2026 \u00e0 17:10")).toBe(new Date(2026, 8, 23, 17, 10).toISOString());
    expect(mailboxDate("2 f\u00e9vr. 2026 07:09")).toBe(new Date(2026, 1, 2, 7, 9).toISOString());
    expect(mailboxDate("Mar 2, 2026, 7:09 AM")).toBe(new Date(2026, 2, 2, 7, 9).toISOString());
    expect(mailboxDate("Sep 23, 2026, 5:10 PM GMT+02:00")).toBe("2026-09-23T15:10:00.000Z");
    expect(mailboxDate("Sep 23, 2026, 5:10 PM UTC")).toBe("2026-09-23T17:10:00.000Z");
    for (const text of ["Yesterday", "Today", "09/10/2026", "Sep 23", "Feb 30, 2026, 5:10 PM",
      "Sep 23, 2026, 13:10 PM", "Sep 23, 2026, 25:10", "Sep 23, 2026, 5:99 PM", "Sep 23, 2026, 5:10 PM PST"])
      expect(mailboxDate(text)).toBeUndefined();
  });
  it("compares actual instants across time zones and restores dates from older browser captures", () => {
    const message = demoData().messages[0];
    const old = { ...message, id: "old", receivedAt: "2026-09-23T10:00:00+02:00" };
    const recent = { ...message, id: "recent", receivedAt: "2026-09-23T09:00:00Z" };
    expect([old, recent].sort(compareRecentMessages).map(item => item.id)).toEqual(["recent", "old"]);
    const captured = { ...message, receivedAt: "", browser: { completeness: "full" as const,
      capturedAt: "2026-10-01T00:00:00Z", dateText: "Sep 21, 2026, 5:10 PM UTC" } };
    expect(messageReceivedAt(captured)).toBe("2026-09-21T17:10:00.000Z");
    expect([captured, recent].sort(compareRecentMessages)[0].id).toBe("recent");
  });
  it("orders and dates the whole conversation independently of selection, draft anchors and filtered text", () => {
    const base = demoData().messages[0];
    const first = { ...base, id: "first", threadId: "a", receivedAt: "2026-09-20T10:00:00Z" };
    const reply = { ...base, id: "reply", threadId: "a", receivedAt: "2026-09-23T10:00:00Z" };
    const other = { ...base, id: "other", threadId: "b", receivedAt: "2026-09-22T10:00:00Z" };
    const rows = inboxConversations([other, first], "first", new Set(["first"]), [other, reply, first]);
    expect(rows.map(row => row.message.id)).toEqual(["first", "other"]);
    expect(rows[0].latest.id).toBe("reply");
    const otherInbox = { ...reply, id: "separate", accountId: "other-account", receivedAt: "2026-09-24T10:00:00Z" };
    expect(inboxConversations([first, otherInbox], "", new Set(), [first, reply, otherInbox])).toHaveLength(2);
  });
});

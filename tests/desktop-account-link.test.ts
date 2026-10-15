import { describe, expect, it } from "vitest";
import { ACCOUNT_LINK_ERROR, ACCOUNT_LINK_MAX_LENGTH, parseBrowserAccountLink } from "../src/shared/browser-account-link";
import { commandSchema } from "../src/main/ipc/schema";

const valid = [
  ["https://mail.google.com/mail/", "https://mail.google.com/mail/#inbox"],
  [" https://mail.google.com/mail/u/1/#inbox/synthetic-message ", "https://mail.google.com/mail/u/1/#inbox"],
  ["https://mail.google.com/mail/u/0?compose=synthetic-draft#drafts", "https://mail.google.com/mail/u/0/#inbox"],
  ["https://mail.google.com/mail/u/9999/search/synthetic?q=synthetic&view=cm&to=test@example.com", "https://mail.google.com/mail/u/9999/#inbox"],
  ["https://mail.google.com/mail/?authuser=Test%2Bwork%40example.com&compose=synthetic#search/synthetic", "https://mail.google.com/mail/?authuser=test%2Bwork%40example.com#inbox"],
  ["https://mail.google.com/mail/?authuser=2", "https://mail.google.com/mail/u/2/#inbox"],
  ["https://mail.google.com/mail/u/2/?authuser=2", "https://mail.google.com/mail/u/2/#inbox"],
  ["https://mail.google.com/%6dail/%75/%31/#all/synthetic", "https://mail.google.com/mail/u/1/#inbox"],
  ["HTTPS://MAIL.GOOGLE.COM:443/mail/", "https://mail.google.com/mail/#inbox"],
  ["https://calendar.google.com/calendar/", "https://calendar.google.com/calendar/"],
  ["https://calendar.google.com/calendar/u/3/r/eventedit/synthetic?eid=synthetic#event", "https://calendar.google.com/calendar/u/3/"],
  ["https://calendar.google.com/calendar/r?authuser=test%40example.com&action=TEMPLATE&text=synthetic", "https://calendar.google.com/calendar/?authuser=test%40example.com"],
  ["https://calendar.google.com/calendar/?%61uthuser=test%40example.com", "https://calendar.google.com/calendar/?authuser=test%40example.com"],
  ["https://calendar.google.com/calendar/?authuser=%30", "https://calendar.google.com/calendar/u/0/"],
  ["https://calendar.google.com/%63alendar/u/%32/r", "https://calendar.google.com/calendar/u/2/"]
] as const;
const invalid = [
  "", "not a link", "//mail.google.com/mail/", "http://mail.google.com/mail/",
  "javascript:alert(1)", "file:///mail/", "https://example.com/mail/",
  "https://mail.google.com.evil.example/mail/", "https://evilmail.google.com/mail/",
  "https://mail.google.com./mail/", "https://mail%2egoogle.com/mail/",
  "https://accounts.google.com/AddSession", "https://mail.google.com/calendar/",
  "https://calendar.google.com/mail/", "https://mail.google.com/", "https://mail.google.com/mailbox/",
  "https://mail.google.com/mail", "https://mail.google.com:444/mail/",
  "https://mail.google.com:80/mail/", "https://test@mail.google.com/mail/",
  "https://test:secret@mail.google.com/mail/", "https://@mail.google.com/mail/",
  "https://mail.google.com\\@example.com/mail/", "https://mail.google.com/ma\nil/",
  "https://mail.google.com/mail/../other/", "https://mail.google.com/other/../mail/",
  "https://mail.google.com/mail/%2e%2e/mail/", "https://mail.google.com/mail%2fu/1/",
  "https://mail.google.com/mail/u%2f1/", "https://mail.google.com/mail/%5cu/1/",
  "https://mail.google.com/mail/%2575/1/", "https://mail.google.com/mail/%ZZ/",
  "https://mail.google.com/mail/%00/", "https://mail.google.com/mail/u/",
  "https://mail.google.com/mail/u/nope/", "https://mail.google.com/mail/u/-1/",
  "https://mail.google.com/mail/u/01/", "https://mail.google.com/mail/u/10000/",
  "https://mail.google.com/mail/u/1/u/2/", "https://mail.google.com/mail/r/u/2/",
  "https://mail.google.com/mail/?authuser=", "https://mail.google.com/mail/?authuser=not-an-email",
  "https://mail.google.com/mail/?authuser=test%2540example.com",
  "https://mail.google.com/mail/?authuser=test%40example.com%0a",
  "https://mail.google.com/mail/?authuser=test%40example.com&authuser=test%40example.com",
  "https://mail.google.com/mail/?authuser=1&%61uthuser=2",
  "https://mail.google.com/mail/u/1/?authuser=2",
  "https://mail.google.com/mail/u/1/?authuser=test%40example.com",
  "https://calendar.google.com/calendar/?authuser=test@example.com%26action=TEMPLATE",
  `https://mail.google.com/mail/#${"x".repeat(ACCOUNT_LINK_MAX_LENGTH)}`
];

describe("desktop account link boundary", () => {
  it.each(valid.map(([input, expected], index) => ({ input, expected, index })))("canonicalizes supported route $index", ({ input, expected }) => {
    const result = parseBrowserAccountLink(input);
    expect(result.link?.url).toBe(expected);
    expect(result.link?.kind).toBe(expected.includes("mail.google.com") ? "mail" : "calendar");
    expect(commandSchema.safeParse({ type: "browser.open-link", url: input }).success).toBe(true);
    expect(parseBrowserAccountLink(expected)).toEqual(result);
  });
  it.each(invalid.map((input, index) => ({ input, index })))("rejects unsupported route $index without echoing it", ({ input }) => {
    expect(parseBrowserAccountLink(input)).toEqual({ error: ACCOUNT_LINK_ERROR });
    expect(commandSchema.safeParse({ type: "browser.open-link", url: input }).success).toBe(false);
  });
  it("does not permit link opening to carry account identity or consent", () => {
    const command = { type: "browser.open-link", url: valid[0][0] };
    for (const extra of [{ accountId: "synthetic" }, { consent: true }, { aiEnabled: true }, { kind: "mail" }])
      expect(commandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "browser.open-link" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "browser.open", kind: "mail" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "browser.open", kind: "calendar", accountId: "synthetic" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "browser.open", kind: "add-account" }).success).toBe(true);
  });
});

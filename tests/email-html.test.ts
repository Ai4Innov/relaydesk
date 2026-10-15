import { describe, expect, it } from "vitest";
import { gmailMessage } from "../src/main/connectors/gmail";
import { graphMessage } from "../src/main/connectors/microsoft";
import type { Account, Source } from "../src/shared/contracts";

const account: Account = { id: "a", provider: "gmail", name: "Test", email: "test@example.com", status: "connected", consent: true, aiEnabled: false };
const source: Source = { id: "s", accountId: "a", providerId: "inbox", name: "Inbox", kind: "mail", selected: true };
describe("email presentation content", () => {
  it("keeps Gmail plain text for retrieval and excludes HTML attachments from presentation", () => {
    const message = gmailMessage(account, source, {
      id: "m", threadId: "t", historyId: "1", internalDate: "1700000000000",
      payload: { mimeType: "multipart/mixed", parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("Plain email").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<h2>Formatted email</h2>").toString("base64url") } },
        ] },
        { filename: "attachment.html", mimeType: "text/html", body: { data: Buffer.from("<h1>Not body</h1>").toString("base64url") } },
      ] },
    }, false).message;
    expect(message.body).toBe("Plain email");
    expect(message.html).toBe("<h2>Formatted email</h2>");
  });
  it("retains Microsoft markup separately without changing plain-text body", () => {
    const message = graphMessage({ ...account, provider: "microsoft" }, source,
      { id: "m", conversationId: "t", body: { contentType: "html", content: "<p>Hello <b>team</b></p>" }, receivedDateTime: "2026-09-23T08:00:00Z" }, false);
    expect(message.html).toBe("<p>Hello <b>team</b></p>");
    expect(message.body).not.toContain("<b>");
    expect(message.body).toContain("team");
  });
});

import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/contracts";
import { fullThreadMessages, isMailPreview, preferredMailEvidence } from "../src/shared/mail-evidence";

const preview: Message = { id: "preview", accountId: "a", sourceId: "mail", threadId: "a:thread:legacy",
  providerId: "thread:legacy", subject: "Synthetic", sender: "", recipients: [], body: "Snippet",
  receivedAt: "", url: "", unread: false, revision: "preview-r1", historical: true,
  browser: { completeness: "preview", capturedAt: "", dateText: "" } };
const full: Message = { ...preview, id: "full", providerId: "actual-id", body: "Actual full message body",
  browser: { ...preview.browser!, completeness: "full" } };

describe("local mail evidence selection", () => {
  it("retains a new-reply preview until its newer full body has actually downloaded", () => {
    const newPreview = { ...preview, receivedAt: "2026-09-25T14:00:00Z" };
    const oldFull = { ...full, receivedAt: "2026-09-24T12:00:00Z" };
    expect(preferredMailEvidence([newPreview, oldFull])).toEqual([newPreview, oldFull]);
    const newFull = { ...full, id: "new-body", receivedAt: newPreview.receivedAt };
    expect(preferredMailEvidence([newPreview, oldFull, newFull])).toEqual([oldFull, newFull]);
  });
  it("keeps every actual message but removes only its exact thread's preview", () => {
    const second = { ...full, id: "full-2", providerId: "actual-2" };
    const otherAccount = { ...preview, id: "other-account", accountId: "ab" };
    const otherSource = { ...preview, id: "other-source", sourceId: "mail-other" };
    const otherThread = { ...preview, id: "other-thread", threadId: "a:thread:other" };
    const messages = [preview, full, second, otherAccount, otherSource, otherThread];
    expect(preferredMailEvidence(messages).map(message => message.id)).toEqual([
      "full", "full-2", "other-account", "other-source", "other-thread"
    ]);
    expect(fullThreadMessages(preview, messages)).toEqual([full, second]);
    expect(preview.revision).toBe("preview-r1");
  });
  it("does not mistake a deleted body, legacy thread row or unproven browser body for downloaded evidence", () => {
    for (const candidate of [{ ...full, deleted: true }, { ...full, providerId: preview.providerId },
      { ...full, browser: undefined }]) {
      expect(fullThreadMessages(preview, [preview, candidate])).toEqual([]);
      expect(preferredMailEvidence([preview, candidate])).toContain(preview);
    }
    expect(isMailPreview({ ...preview, browser: undefined })).toBe(true);
    expect(fullThreadMessages({ ...preview, threadId: "" }, [{ ...full, threadId: "" }])).toEqual([]);
  });
  it("prefers relay/API full bodies of the same mailbox over browser previews and duplicate browser copies", () => {
    const mailbox = (accountId: string) => ({ browser: "me@example.com", relay: "me@example.com", other: "other@example.com" } as Record<string, string>)[accountId];
    const browserPreview: Message = { ...preview, id: "bp", accountId: "browser", sourceId: "browser:mail",
      threadId: "browser:thread:1a13595f3b339c5d", providerId: "thread:1a13595f3b339c5d", receivedAt: "2026-09-29T08:00:00Z" };
    const browserFull: Message = { ...full, id: "bf", accountId: "browser", sourceId: "browser:mail",
      threadId: browserPreview.threadId, providerId: "19a0000000000001", receivedAt: "2026-09-29T08:00:00Z" };
    const relayFull: Message = { ...full, id: "rf", accountId: "relay", sourceId: "relay:mail", browser: undefined,
      threadId: "hashed-thread", providerId: "19a0000000000001", receivedAt: "2026-09-29T08:00:00Z",
      url: "https://mail.google.com/mail/u/me%40example.com/#all/1a13595f3b339c5d" };
    const otherMailbox: Message = { ...browserPreview, id: "op", accountId: "other" };
    const selected = preferredMailEvidence([browserPreview, browserFull, relayFull, otherMailbox], mailbox).map(message => message.id);
    expect(selected).toEqual(["rf", "op"]);
    expect(fullThreadMessages(browserPreview, [browserPreview, relayFull, otherMailbox], mailbox)).toEqual([relayFull]);
    // A newer browser preview of the same thread stays visible until the relay delivers that reply.
    const newer = { ...browserPreview, receivedAt: "2026-09-29T09:00:00Z" };
    expect(preferredMailEvidence([newer, relayFull], mailbox).map(message => message.id)).toEqual(["bp", "rf"]);
    // Without the mailbox lookup, behaviour stays account-scoped.
    expect(preferredMailEvidence([browserPreview, relayFull]).map(message => message.id)).toEqual(["bp", "rf"]);
  });
});

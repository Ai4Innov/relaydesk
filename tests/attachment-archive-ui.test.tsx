import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttachmentArchive } from "../src/renderer/AttachmentArchive";
import { defaultSettings } from "../src/shared/defaults";
import type { Attachment, Snapshot } from "../src/shared/contracts";

function fixture(): Snapshot {
  const attachment: Attachment = { id: "file", accountId: "a", messageId: "outside-window", providerId: "file.txt",
    name: "file.txt", mimeType: "text/plain", status: "indexed", hash: "retained",
    browser: { source: "browser_gmail", metadataId: "file.txt" }, sourceId: "mail", parentAvailable: true };
  return {
    accounts: [{ id: "a", name: "Synthetic", email: "test@example.org", provider: "gmail", connection: "browser",
      status: "connected", consent: true, aiEnabled: false }],
    sources: [{ id: "mail", accountId: "a", providerId: "mail", name: "Inbox", kind: "mail", selected: true }],
    messages: [], attachments: [attachment, { ...attachment, id: "awaiting", status: "awaiting-approval", hash: undefined },
      { ...attachment, id: "partial", status: "partial" }], drafts: [], events: [], actions: [], jobs: [], approvals: [],
    settings: { ...defaultSettings, browserAttachmentDownload: true }, models: [], copilot: { status: "disconnected", message: "" },
    demo: false, archive: { messages: 0, attachments: 3, indexed: 2, searchMode: "keyword", bytes: 100 }
  };
}
describe("local attachment coverage", () => {
  it("distinguishes saved files, indexed text, partial evidence and approvals with AI disabled", () => {
    const html = renderToStaticMarkup(<AttachmentArchive data={fixture()} busy={false} run={vi.fn()}/>);
    expect(html).toContain("2 of 3 files stored locally");
    expect(html).toContain("1 indexed");
    expect(html).toContain("1 partially indexed");
    expect(html).toContain("1 awaiting approval");
    expect(html).toContain("Metadata alone is not searchable file content");
    expect(html).toContain("checked");
  });
  it("excludes unselected sources and explains missing metadata rather than claiming downloaded files", () => {
    const data = fixture();
    data.sources[0].selected = false;
    data.settings.browserAttachmentDownload = false;
    const html = renderToStaticMarkup(<AttachmentArchive data={data} busy={false} run={vi.fn()}/>);
    expect(html).toContain("0 of 0 files stored locally");
    expect(html).toContain("No Gmail attachment metadata has been captured yet");
    expect(html).toContain("Paused");
  });
  it("does not mistake legacy full-email bodies for completed attachment discovery", () => {
    const data = fixture();
    data.messages = [{ id: "outside-window", accountId: "a", sourceId: "mail", providerId: "message",
      threadId: "thread", subject: "Synthetic", sender: "author@example.org", recipients: [], body: "A complete body.",
      receivedAt: "", url: "", unread: false, revision: "1", historical: true,
      browser: { completeness: "full", capturedAt: "2026-09-24T00:00:00Z", dateText: "" } }];
    const render = () => renderToStaticMarkup(<AttachmentArchive data={data} busy={false} run={vi.fn()}/>);
    expect(render()).toContain("1 displayed full messages still need their attachments checked");
    data.messages[0].browser!.attachmentManifestVersion = 1;
    expect(render()).not.toContain("still need their attachments checked");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { accessibleDocument, DocumentActions, DocumentWorkspace } from "../src/renderer/DocumentViewer";
import { defaultSettings } from "../src/shared/defaults";
import type { Snapshot } from "../src/shared/contracts";

export function documentSnapshot(): Snapshot {
  return {
    accounts: [{ id: "account", provider: "gmail", connection: "browser", email: "documents@example.org", name: "Documents", status: "connected", consent: true, aiEnabled: false }],
    sources: [{ id: "source", accountId: "account", providerId: "inbox", name: "Inbox", kind: "mail", selected: true }],
    messages: [{ id: "message", accountId: "account", sourceId: "source", providerId: "remote", threadId: "thread", subject: "Project documents", sender: "author@example.org", recipients: [], body: "Review the attached documents.", receivedAt: "2026-09-23T08:00:00Z", url: "", unread: false, revision: "1", historical: false }],
    attachments: [{ id: "document", accountId: "account", messageId: "message", providerId: "remote-file", name: "Review.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", status: "indexed", hash: "retained" }],
    settings: defaultSettings, models: [], copilot: { status: "disconnected", message: "" }, demo: false,
    drafts: [], events: [], actions: [], jobs: [], approvals: [],
    archive: { messages: 1, attachments: 1, indexed: 1, searchMode: "keyword", bytes: 100 },
  };
}

describe("internal document controls", () => {
  it("allows local viewing without AI sharing, and never requests content until clicked", () => {
    const data = documentSnapshot(), run = vi.fn();
    expect(accessibleDocument(data, "document")?.name).toBe("Review.docx");
    const html = renderToStaticMarkup(<DocumentWorkspace data={data} run={run}><DocumentActions attachmentId="document"/></DocumentWorkspace>);
    expect(html).toContain("View document");
    expect(html).toContain("Save to Downloads");
    expect(html).not.toContain("<dialog");
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["source", "account", "consent", "message", "attachment", "mismatch"])("rejects a revoked or mismatched %s", reason => {
    const data = documentSnapshot();
    if (reason === "source") data.sources[0].selected = false;
    if (reason === "account") data.accounts[0].status = "disconnected";
    if (reason === "consent") data.accounts[0].consent = false;
    if (reason === "message") data.messages[0].deleted = true;
    if (reason === "attachment") data.attachments = [];
    if (reason === "mismatch") data.sources[0].accountId = "other-account";
    expect(accessibleDocument(data, "document")).toBeUndefined();
    expect(renderToStaticMarkup(<DocumentWorkspace data={data} run={vi.fn()}><DocumentActions attachmentId="document"/></DocumentWorkspace>)).not.toContain("<button");
  });
  it("offers a metadata preview but disables save when no original is retained", () => {
    const data = documentSnapshot();
    delete data.attachments[0].hash;
    const html = renderToStaticMarkup(<DocumentWorkspace data={data} run={vi.fn()}><DocumentActions attachmentId="document"/></DocumentWorkspace>);
    expect(html).toContain("View document");
    expect(html).toContain("disabled");
    expect(html).toContain("Import or process the original first.");
  });
  it("uses trusted parent access metadata for an older attachment outside the latest 500 messages", () => {
    const data = documentSnapshot();
    const original = data.messages[0];
    data.messages = Array.from({ length: 500 }, (_, index) => ({ ...original, id: `recent-${index}` }));
    Object.assign(data.attachments[0], { sourceId: "source", parentAvailable: true });
    expect(data.accounts[0].aiEnabled).toBe(false);
    expect(accessibleDocument(data, "document")?.id).toBe("document");
    data.sources[0].selected = false;
    expect(accessibleDocument(data, "document")).toBeUndefined();
    data.sources[0].selected = true;
    data.attachments[0].parentAvailable = false;
    expect(accessibleDocument(data, "document")).toBeUndefined();
  });
  it("never infers older document access from a model citation or an unverified source ID", () => {
    const data = documentSnapshot();
    data.messages = [];
    data.attachments[0].sourceId = "source";
    expect(accessibleDocument(data, "document")).toBeUndefined();
    data.attachments[0].parentAvailable = true;
    data.attachments[0].sourceId = "unknown-source";
    expect(accessibleDocument(data, "document")).toBeUndefined();
    data.attachments[0].sourceId = "source";
    data.messages = [{ ...documentSnapshot().messages[0], deleted: true }];
    expect(accessibleDocument(data, "document")).toBeUndefined();
  });
});

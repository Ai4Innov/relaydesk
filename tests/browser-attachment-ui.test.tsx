import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserAttachmentAction } from "../src/renderer/BrowserAttachmentAction";
import type { Attachment } from "../src/shared/contracts";

const attachment: Attachment = { id: "synthetic", accountId: "synthetic", messageId: "synthetic", providerId: "notes.txt",
  name: "notes.txt", mimeType: "application/octet-stream", status: "pending",
  browser: { source: "browser_gmail", metadataId: "notes.txt" } };
describe("browser attachment import presentation", () => {
  it("offers Gmail download and indexing alongside the manual import fallback", () => {
    const html = renderToStaticMarkup(<BrowserAttachmentAction attachment={attachment} busy={false} run={vi.fn()}/>);
    expect(html).toContain("Import downloaded file");
    expect(html).toContain("Download and index");
    expect(html).toContain("Selected Gmail attachments download automatically");
    expect(html).toContain("encrypted");
  });
  it("distinguishes approval and encrypted-original retries from selecting another downloaded copy", () => {
    const render = (patch: Partial<Attachment>) => renderToStaticMarkup(
      <BrowserAttachmentAction attachment={{ ...attachment, ...patch }} busy={false} run={vi.fn()}/>);
    expect(render({ status: "awaiting-approval" })).toContain("Approve and import downloaded file");
    const retained = render({ hash: "retained", status: "blocked" });
    expect(retained).toContain("Retry processing");
    expect(retained).not.toContain("Metadata only");
    expect(retained).not.toContain("Import downloaded file");
    expect(render({ status: "unsupported" })).not.toContain("<button");
  });
  it("names WhatsApp rather than Gmail for a WhatsApp downloaded-copy import", () => {
    const html = renderToStaticMarkup(<BrowserAttachmentAction attachment={{ ...attachment,
      browser: { source: "browser_whatsapp", metadataId: "notes.txt" } }} busy={false} run={vi.fn()}/>);
    expect(html).toContain("Download the original attachment in WhatsApp");
    expect(html).not.toContain("Gmail");
    expect(html).toContain("does not download it automatically");
  });
});

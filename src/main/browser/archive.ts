import { createHash } from "node:crypto";
import type { BrowserAccess, BrowserAttachment, BrowserCalendarItem, BrowserCapture, BrowserRegistration } from "../../shared/browser";
import type { Account, Attachment, Draft, Message, Source } from "../../shared/contracts";
import type { Vault } from "../storage/vault";
import { browserAttachmentsSchema } from "./attachment-schema";
import { attachmentFormat } from "../attachments/policy";
import { mailboxDate } from "../../shared/mail-date";

export const browserAccountId = (email: string, kind: BrowserRegistration["kind"] = "mail") =>
  `browser:${kind === "whatsapp" ? "whatsapp" : "google"}:${email.trim().toLowerCase()}`;
const sourceId = (accountId: string, kind: string) => `${accountId}:${kind}`;
const registrationSourceId = (accountId: string, input: BrowserRegistration) => input.kind === "whatsapp"
  ? input.chat && sourceId(accountId, `chat:${encodeURIComponent(input.chat.id)}`) : sourceId(accountId, input.kind);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const browserAttachmentId = (accountId: string, messageId: string, item: Pick<BrowserAttachment, "id" | "name" | "mimeType">) =>
  `browser-attachment:${digest([accountId, messageId, item.id, item.name, item.mimeType])}`;
const contentRevision = (message: Message) => digest({
  providerId: message.providerId, threadId: message.threadId, subject: message.subject, sender: message.sender,
  recipients: message.recipients, body: message.body, receivedAt: message.receivedAt, url: message.url,
  completeness: message.browser?.completeness,
  attachmentRevision: message.browser?.attachmentRevision ?? digest([])
});
function accountUrl(value: string, email: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/u\/\d+(?=\/|$)/, "");
  url.searchParams.set("authuser", email);
  return url.href;
}

export class BrowserArchive {
  constructor(private vault: Vault, private index: (message: Message) => Promise<void>, private changed: () => void,
    private paused: () => boolean) {}

  discover(input: BrowserRegistration): BrowserAccess {
    const whatsapp = input.kind === "whatsapp";
    if (whatsapp && (!/^\+[1-9]\d{6,14}$/.test(input.accountEmail)
      || (input.chat && !/^[0-9]{5,20}(?:-[0-9]{5,20})?@(?:c\.us|g\.us|lid)$/.test(input.chat.id))))
      throw new Error("Invalid WhatsApp account or chat identity.");
    const email = input.accountEmail.trim().toLowerCase(), accountId = browserAccountId(email, input.kind);
    const existing = this.vault.get<Account>("accounts", accountId);
    const account: Account = existing ?? { id: accountId, provider: whatsapp ? "whatsapp" : "gmail", connection: "browser", email,
      name: input.accountName || email, consent: !whatsapp, aiEnabled: false, status: "connected" };
    // A disconnected/forgotten account must not be silently re-authorized by an open tab.
    if (this.vault.get("checkpoints", `browser-forgotten:${accountId}`)) throw new Error("This browser account was forgotten. Pair again to authorize discovery.");
    if (existing?.status === "disconnected") throw new Error("This browser account is disconnected. Pair again to reconnect.");
    this.vault.transaction(() => {
      this.vault.put("accounts", accountId, account);
      if (whatsapp && input.chat) {
        const id = registrationSourceId(accountId, input)!;
        if (!this.vault.get("sources", id)) this.vault.put("sources", id, { id, accountId,
          providerId: input.chat.id, kind: "channel", name: `${input.chat.name || input.chat.id} · WhatsApp (${input.chat.id})`,
          selected: false } satisfies Source);
      }
      for (const kind of whatsapp ? [] : ["mail", "calendar"] as const) {
        const id = sourceId(accountId, kind);
        if (!this.vault.get("sources", id)) this.vault.put("sources", id, { id, accountId, providerId: kind, kind,
          name: kind === "mail" ? "Gmail pages (browser)" : "Calendar & meetings (browser)", selected: false } satisfies Source);
      }
    });
    this.changed();
    const selected = registrationSourceId(accountId, input);
    return { accountId, enabled: !this.paused() && account.consent && account.status === "connected"
      && !!selected && !!this.vault.get<Source>("sources", selected)?.selected };
  }

  async capture(input: BrowserCapture): Promise<Message[]> {
    if (this.paused()) throw new Error("Browser capture is paused in Relay Desk.");
    const whatsapp = input.kind === "whatsapp";
    const accountId = browserAccountId(input.accountEmail, input.kind), selected = registrationSourceId(accountId, input);
    const account = this.vault.get<Account>("accounts", accountId);
    if (!account || account.connection !== "browser" || account.status !== "connected" || !account.consent)
      throw new Error("Connect this browser account before capturing.");
    if (!selected || !this.vault.get<Source>("sources", selected)?.selected) throw new Error("Select this account's source in Relay Desk first.");
    if (input.kind === "mail" && input.messages.some(item =>
      item.completeness === "preview" && !item.subject.trim() && !item.body.trim()))
      throw new Error("Gmail previews contain no readable text. Activate the Gmail tab and capture again; existing messages were preserved.");
    if (whatsapp && (input.meetings.length || input.messages.some(item => item.threadId !== input.chat?.id
      || !new RegExp(`^(?:true|false)_${input.chat!.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_`).test(item.id)
      || item.completeness !== "full" || item.html !== undefined || item.url !== "https://web.whatsapp.com/")))
      throw new Error("WhatsApp capture must match the selected conversation.");
    const capturedAt = new Date().toISOString(), imported: Message[] = [];
    for (const [position, item] of input.messages.entries()) {
      if (this.paused() || this.vault.get<Account>("accounts", accountId)?.status !== "connected" ||
        !this.vault.get<Account>("accounts", accountId)?.consent ||
        !this.vault.get<Source>("sources", selected)?.selected)
        throw new Error("Browser account or source was excluded during capture.");
      const id = `${accountId}:message:${encodeURIComponent(item.id)}`;
      const old = this.vault.get<Message>("messages", id);
      if (item.completeness !== "full" && item.attachments?.length)
        throw new Error("Attachment metadata requires a full message.");
      const metadata = item.completeness === "full" && item.attachments !== undefined
        ? browserAttachmentsSchema.parse(item.attachments) : undefined;
      if (item.attachmentManifestVersion !== undefined && (item.attachmentManifestVersion !== 1 || metadata === undefined))
        throw new Error("A versioned attachment manifest requires an inspected full message.");
      const url = whatsapp ? "https://web.whatsapp.com/" : accountUrl(item.url, account.email);
      const receivedAt = item.receivedAt || (!whatsapp && mailboxDate(item.dateText)) || old?.receivedAt || "";
      let message: Message = { id, accountId, sourceId: selected, providerId: item.id,
        threadId: `${accountId}:thread:${encodeURIComponent(item.threadId)}`, subject: item.subject, sender: item.sender,
        recipients: item.recipients, body: item.body,
        ...(item.html !== undefined ? { html: item.html } : old?.html !== undefined && old.body === item.body ? { html: old.html } : {}),
        receivedAt, url, unread: item.unread,
        revision: "", historical: !receivedAt || Date.parse(receivedAt) < Date.now() - 86400000,
        ...(old?.gmailApi ? { gmailApi: old.gmailApi } : {}),
        browser: { completeness: item.completeness, capturedAt, dateText: item.dateText, position } };
      if (old?.browser?.completeness === "full" && item.completeness === "preview")
        message = { ...old, unread: item.unread, browser: { ...old.browser, capturedAt, dateText: item.dateText, position } };
      // Missing metadata (older companions/previews) is not evidence that a downloaded file disappeared.
      message.browser!.attachmentRevision = metadata === undefined ? old?.browser?.attachmentRevision
        : digest(metadata.map(({ id, name, mimeType }) => ({ id, name, mimeType })).sort((a, b) => a.id.localeCompare(b.id)));
      message.browser!.attachmentManifestVersion = metadata === undefined ? old?.browser?.attachmentManifestVersion
        : item.attachmentManifestVersion;
      const revision = old && contentRevision(old) === contentRevision(message) ? old.revision : contentRevision(message);
      message.revision = revision;
      this.vault.transaction(() => {
        this.vault.put("messages", id, message);
        for (const item of metadata ?? []) {
          const attachmentId = browserAttachmentId(accountId, id, item);
          const supported = Boolean(attachmentFormat(item));
          const existing = this.vault.get<Attachment>("attachments", attachmentId);
          if (existing && !existing.hash && existing.size === undefined && item.size !== undefined)
            this.vault.put("attachments", attachmentId, { ...existing, size: item.size,
              ...(existing.status === "awaiting-approval" && /size is unknown/i.test(existing.reason ?? "")
                ? { status: "pending", reason: "Native Gmail attachment size is now known; queued for policy-checked download." } : {}) });
          if (!existing)
            this.vault.put("attachments", attachmentId, {
              id: attachmentId, accountId, messageId: id, providerId: item.id,
              name: item.name, mimeType: item.mimeType, size: item.size, status: supported ? "pending" : "unsupported",
              browser: { source: whatsapp ? "browser_whatsapp" : "browser_gmail", metadataId: item.id },
              reason: supported
                ? whatsapp ? "Download this attachment in WhatsApp, then choose Import downloaded file."
                  : "Queued for automatic Gmail attachment download and encrypted local processing. Unknown-size or large files require approval."
                : "This file type is not supported. Executables, scripts, macros and arbitrary external links are never opened."
            } satisfies Attachment);
        }
        if (old && old.revision !== revision)
          for (const draft of this.vault.all<Draft>("drafts").filter(draft => draft.messageId === id))
            this.vault.put("drafts", draft.id, { ...draft, status: "stale" });
      });
      // Always retry indexing: an earlier capture may have saved the record before an index failure.
      await this.index(message);
      if (!old || old.revision !== revision) imported.push(message);
    }
    const current = this.vault.get<Account>("accounts", accountId);
    const currentSource = this.vault.get<Source>("sources", selected);
    if (this.paused() || !current || current.status !== "connected" || !current.consent || !currentSource?.selected)
      throw new Error("Browser account or source was excluded during capture.");
    this.vault.transaction(() => {
      for (const item of input.meetings) {
        const record: BrowserCalendarItem = { ...item, url: accountUrl(item.url, account.email),
          meetingUrl: item.meetingUrl ? accountUrl(item.meetingUrl, account.email) : undefined,
          id: `${accountId}:meeting:${encodeURIComponent(item.id)}`, accountId,
          sourceId: selected, capturedAt };
        this.vault.put("browserItems", record.id, record);
      }
      this.vault.put("accounts", accountId, { ...current, lastSync: capturedAt, error: undefined });
      this.vault.put("sources", selected, { ...currentSource, lastSync: capturedAt });
    });
    this.changed();
    return imported;
  }
}

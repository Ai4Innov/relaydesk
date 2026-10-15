import type { Account, Source } from "../../shared/contracts";
import type { BrowserCapture } from "../../shared/browser";
import type { BrowserMailRequest } from "../../shared/browser-mail";
import type { GmailApiOrigin, MailTransportStatus } from "../../shared/mail-transport";
import type { MailVault } from "./mail-reader";

interface Reader {
  readMailThread(input: BrowserMailRequest, guard: () => void, signal?: AbortSignal): Promise<BrowserCapture>;
}
interface GmailReader {
  hasGmailReadConfiguration(account: Account): boolean;
  readGmailMail(account: Account, source: Source, input: BrowserMailRequest,
    guard: () => void, signal?: AbortSignal): Promise<BrowserCapture>;
}
const email = (value: string) => value.trim().toLowerCase();
class GmailRouteUnavailable extends Error {}

export class GmailMailTransport implements Reader {
  private origins = new WeakMap<BrowserCapture, GmailApiOrigin>();
  constructor(private vault: MailVault, private api: GmailReader, private playwright?: Reader,
    private companion?: Reader, private preference: () => "auto" | "companion" = () => "auto") {}

  private apiRoute(owner: Account): { account: Account; source: Source } | undefined {
    for (const account of this.vault.all<Account>("accounts")) {
      if (account.provider !== "gmail" || account.connection === "browser" || account.demo
        || email(account.email) !== email(owner.email)) continue;
      if (account.status !== "connected" || !account.consent || !this.api.hasGmailReadConfiguration(account))
        throw new GmailRouteUnavailable("This mailbox has a Gmail API connection that needs authorization. Reconnect it; browser fallback does not bypass revoked API access.");
      const source = this.vault.all<Source>("sources").find(source => source.accountId === account.id
        && source.kind === "mail" && source.providerId === "INBOX" && source.selected);
      if (source) return { account, source };
      throw new GmailRouteUnavailable("Select Inbox on this mailbox's Gmail API account. Browser fallback does not bypass an excluded API source.");
    }
    return undefined;
  }
  status(account: Account): MailTransportStatus {
    if (account.provider !== "gmail" || account.demo || !account.consent || account.status !== "connected")
      return { accountId: account.id, transport: "unavailable", message: "Connect this Gmail account and enable local access." };
    if (account.connection === "browser" && this.preference() === "companion")
      return { accountId: account.id, transport: this.companion ? "companion" : "unavailable",
        message: this.companion
          ? "Direct signed-in browser selected. The paired companion waits for Gmail's account, Inbox and complete conversation before capturing. No managed-browser sign-in is used."
          : "The browser companion is unavailable in this installation." };
    let route: ReturnType<GmailMailTransport["apiRoute"]>;
    try { route = this.apiRoute(account); }
    catch (error) {
      if (!(error instanceof GmailRouteUnavailable)) throw error;
      return { accountId: account.id, transport: "unavailable", message: error.message };
    }
    if (route) return { accountId: account.id, transport: "gmail-api", apiAccountId: route.account.id,
      message: "Gmail API is preferred for this mailbox. Browser automation is not needed for email reads." };
    if (this.playwright) return { accountId: account.id, transport: "playwright",
      message: "No authorized Gmail API Inbox is configured. Playwright requires a Google-permitted browser session; if Google rejects sign-in, connect Gmail API in your normal browser." };
    return { accountId: account.id, transport: this.companion ? "companion" : "unavailable",
      message: "Managed browser support is unavailable in this installation." };
  }
  origin(capture: BrowserCapture): GmailApiOrigin | undefined { return this.origins.get(capture); }
  cacheIdentity(accountId: string): string {
    const account = this.vault.get<Account>("accounts", accountId);
    if (!account) return "unavailable";
    const status = this.status(account);
    return `${status.transport}:${status.apiAccountId ?? ""}`;
  }

  async readMailThread(input: BrowserMailRequest, beforeRead: () => void, signal?: AbortSignal): Promise<BrowserCapture> {
    const validate = () => {
      signal?.throwIfAborted();
      beforeRead();
      const owner = this.vault.get<Account>("accounts", input.accountId);
      if (!owner || owner.provider !== "gmail" || owner.connection !== "browser" || owner.demo
        || !owner.consent || owner.status !== "connected" || email(owner.email) !== email(input.accountEmail)
        || !this.vault.all<Source>("sources").some(source => source.accountId === owner.id && source.selected && source.kind === "mail"))
        throw new Error("Gmail mailbox access is unavailable or was revoked.");
      return owner;
    };
    const owner = validate();
    const preference = this.preference();
    const guardPreference = () => {
      validate();
      if (this.preference() !== preference) throw new Error("Gmail reading method changed during this read. Retry with the selected method.");
    };
    if (preference === "companion") {
      if (!this.companion) throw new Error("Pair the companion in your normally signed-in Chrome or Edge browser.");
      const capture = await (signal ? this.companion.readMailThread(input, guardPreference, signal)
        : this.companion.readMailThread(input, guardPreference));
      guardPreference();
      return capture;
    }
    const route = this.apiRoute(owner);
    if (route) {
      const guard = () => {
        guardPreference();
        const current = this.apiRoute(validate());
        if (current?.account.id !== route.account.id || current.source.id !== route.source.id)
          throw new Error("Gmail API source access changed during this read.");
      };
      // Authentication, policy and quota errors must remain visible, not switch identities/transports.
      const capture = await this.api.readGmailMail(route.account, route.source, input, guard, signal);
      guard();
      this.origins.set(capture, { accountId: route.account.id, sourceId: route.source.id });
      return capture;
    }
    const reader = this.playwright ?? this.companion;
    if (!reader) throw new Error("Configure Gmail API access or open the Playwright fallback browser in Settings.");
    const capture = await (signal ? reader.readMailThread(input, guardPreference, signal) : reader.readMailThread(input, guardPreference));
    guardPreference();
    return capture;
  }
}

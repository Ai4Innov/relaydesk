import { useState } from "react";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";
import type { BrowserPairing } from "../shared/browser";
import { ACCOUNT_LINK_MAX_LENGTH, parseBrowserAccountLink } from "../shared/browser-account-link";

export function BrowserSetup({ data, busy, run }: { data: Snapshot; busy: boolean;
  run: (command: Command, success?: string) => Promise<CommandResult | undefined> }) {
  const [consent, setConsent] = useState(false);
  const [pairing, setPairing] = useState<BrowserPairing>();
  const [accountLink, setAccountLink] = useState("");
  const parsedLink = parseBrowserAccountLink(accountLink);
  return <section className="card settings-section" aria-label="Browser-first connection">
    <span className="eyebrow">BROWSER-FIRST â€” NO API CREDENTIALS</span>
    <h2>Connect your browser</h2>
    <p>Pair your Chrome or Edge browser profile with a code only. No account link or open Gmail tab is needed to pair. Account discovery comes afterwards: each Google account appears separately, with its own Gmail, Calendar and AI controls.</p>
    <ol>
      <li>Open the companion folder. In Chrome or Edge Extensions, enable Developer mode and choose Load unpacked, then select that folder.</li>
      <li>Generate a fresh pairing code here for each browser and enter it in that browser's Relay Desk companion popup. Pin the companion for easy access. Paired browsers will reconcile all already-open Gmail and Calendar tabs, including hidden tabs.</li>
      <li>In the companion, choose Discover signed-in Google accounts and approve optional access to Google's account-menu widget. Keep a Gmail or Calendar page open. Each signed-in account gets a verified inbox view; expired sessions still need Google sign-in. Discover open Google accounts remains available without that optional access.</li>
      <li>Select the discovered account's sources below, then use Refresh now here or Capture now in the companion when you want the current loaded page captured immediately.</li>
    </ol>
    <section className="account-card" aria-label="Pair browser profile">
      <h3>1. Pair this browser profile</h3>
      <p>Open the companion in the browser profile you want to connect, even on a new tab. Enter the code below there. Pairing is for the profile, not for one email account.</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run({ type: "browser.extension" })}>Open companion folder</button>
      <label className="checkbox-label consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)}/>
        I authorize local capture of selected browser sources. WhatsApp also requires account ingestion consent and individual chat selection. AI sharing is a separate opt-in.</label>
      <div className="button-row wrap">
        <button type="button" disabled={busy || !consent} onClick={async () => {
          const result = await run({ type: "browser.pair", consent });
          if (result?.browserPairing) setPairing(result.browserPairing);
        }}>Generate pairing code</button>
        {data.browser?.paired && <button type="button" className="secondary" disabled={busy} onClick={async () => {
          if (await run({ type: "browser.revoke" })) setPairing(undefined);
        }}>Disconnect all browser companions</button>}
      </div>
      {pairing && <p role="status">Pairing code: <strong>{pairing.code}</strong> - expires {new Date(pairing.expiresAt).toLocaleTimeString()}. Use a fresh code if it expires.</p>}
      <p role="status">{data.browser?.paired ? "Browser companion paired - additional browsers can pair without disconnecting it" : "Browser companion not paired"}
        {data.browser?.lastCapture && ` - last capture ${new Date(data.browser.lastCapture).toLocaleString()}`}</p>
      {data.browser?.error && <p role="alert" className="inline-error">{data.browser.error}</p>}
    </section>
    <h3>2. Discover accounts after pairing</h3>
    <p>Open Gmail or Calendar in the paired profile, or use Discover signed-in Google accounts in the companion. No pasted link is required. Select sources separately before content is captured.</p>
    <div className="button-row wrap">
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "mail" })}>Open Gmail</button>
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "calendar" })}>Open Google Calendar</button>
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "whatsapp" })}>Open WhatsApp Web</button>
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "add-account" })}>Add another Google account</button>
    </div>
    <div className="account-card">
      <h3>WhatsApp Web Â· same Edge companion</h3>
      <p>No WhatsApp API token or business account is needed. Reload the updated companion in your already-paired Edge profile (pairing is preserved), then open WhatsApp Web there and link your phone using WhatsApp's normal QR-code flow if needed. The desktop button opens your default browser; the companion's Open WhatsApp Web button uses that companion's profile.</p>
      <p>Open a conversation, then open your own Profile panel from WhatsApp's left navigation and keep its Phone number visible. Relay Desk verifies that phone number on every capture, never a contact name or a chat participant's number. Unsupported profile layouts fail closed.</p>
      <p>Choose Connect current tab in the companion. Enable this WhatsApp account's local ingestion and select each discovered chat under Accounts &amp; selected sources. Then choose Capture now. Open other chats yourself to discover their separate source switches. AI sharing starts off and requires a separate opt-in.</p>
      <p>Only loaded text bubbles and supported file-name metadata from the selected conversation are captured, not all history, voice notes or view-once media. Displayed timestamps are retained without guessing ambiguous dates. Download attachments yourself and import the matching copy when offered. Drafts stay local: copy and open WhatsApp, review and send manually. Relay Desk never clicks Send.</p>
    </div>
    <details className="account-card">
    <summary>Add account by link (optional)</summary>
    <form aria-labelledby="account-link-heading" onSubmit={async event => {
      event.preventDefault();
      if (busy || !parsedLink.link) return;
      if (await run({ type: "browser.open-link", url: parsedLink.link.url })) setAccountLink("");
    }}>
      <h3 id="account-link-heading">Optional account navigation</h3>
      <p id="account-link-help">This is not needed for browser pairing. Paste a Gmail or Google Calendar link only to open a particular account. Only its inbox or calendar root opens; message, event, draft and search details are removed. The link is a routing hint, not proof of identity.</p>
      <label htmlFor="account-link">Gmail or Google Calendar account link</label>
      <input id="account-link" type="url" required maxLength={ACCOUNT_LINK_MAX_LENGTH} autoComplete="off" spellCheck={false}
        placeholder="https://mail.google.com/mail/u/1/" value={accountLink} disabled={busy}
        aria-describedby={`account-link-help account-link-profile${accountLink && !parsedLink.link ? " account-link-error" : ""}`}
        aria-invalid={Boolean(accountLink && !parsedLink.link)} onChange={event => setAccountLink(event.target.value)}/>
      {accountLink && !parsedLink.link && <p id="account-link-error" className="inline-error" role="alert">{parsedLink.error}</p>}
      <p id="account-link-profile">This opens your default browser, not necessarily your paired Edge or Chrome profile. If they differ, use the companion's Add account by link in the paired profile instead.</p>
      <button type="submit" className="secondary" disabled={busy || !parsedLink.link}>Open account page in default browser</button>
      <p className="caption">Opening does not connect an account. Sign in if needed; the paired companion must verify Google's signed-in top header before the account appears. Source selection and AI sharing remain separate opt-ins.</p>
    </form>
    </details>
    {data.browser?.clients?.length ? <div className="account-card">
      <h3>Paired browsers</h3>
      <p>Each pairing belongs to one browser profile. Other Edge or Chrome profiles need their own pairing. Browser names come from authenticated request metadata; secret tokens are never shown.</p>
      <ul>
        {data.browser.clients.map(client => <li key={client.id}>
          <strong>{client.browser === "edge" ? "Microsoft Edge" : client.browser === "chrome" ? "Google Chrome" : "Unknown browser"}</strong>
          {client.lastSeenAt && ` - last seen ${new Date(client.lastSeenAt).toLocaleString()}`}
          {client.discoveredAccountIds?.length ? ` - discovered ${client.discoveredAccountIds.length} account${client.discoveredAccountIds.length === 1 ? "" : "s"}` : ""}
          {client.calendarActions?.ready ? " - Calendar actions ready" : " - Open a selected Calendar tab to check action readiness"}
        </li>)}
      </ul>
    </div> : null}
    {data.accounts.filter(account => account.connection === "browser" && account.status === "connected").map(account =>
      <div className="account-card" key={account.id}><h3>{account.email}</h3>
        <p>Browser connection - {account.provider === "whatsapp" ? "enable ingestion and select individual WhatsApp chats" : "select this account's Gmail and Calendar sources"} in Accounts &amp; selected sources below.</p>
        <div className="button-row wrap">
          {account.provider === "whatsapp"
            ? <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "whatsapp", accountId: account.id })}>Open WhatsApp Web</button>
            : <><button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "mail", accountId: account.id })}>Open this Gmail account</button>
              <button className="secondary" disabled={busy} onClick={() => void run({ type: "browser.open", kind: "calendar", accountId: account.id })}>Open this calendar</button></>}
        </div>
      </div>)}
    <p className="privacy-callout">Background capture reads loaded pages, not invisible full histories. Inbox rows are previews; the full-email queue retrieves discovered conversations and their attachment metadata. The separate attachment queue downloads Gmail files through native links for encrypted local indexing, with approval for unknown-size, large, or costly files. Update the companion and allow Downloads permission. WhatsApp files still require downloaded-copy import. Calendar times remain as displayed. Separately, Chat can propose an exact Google Calendar move for your confirmation; the companion validates the visible editor before saving, and Google may notify guests. It never sends mail or WhatsApp messages, reads passwords, inspects cookies or calls private provider APIs. Browser and Relay Desk must be open. Native Gmail draft saving uses optional same-mailbox API authorization.</p>
  </section>;
}

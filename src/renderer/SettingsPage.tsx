import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, CalendarDays, Database, FolderOpen, Globe, LoaderCircle, Mail, MessageSquare, Plug, Plus, RefreshCw, ShieldCheck, Sparkles, Star, Terminal, Trash2, Wrench, X } from "lucide-react";
import type { Account, Command, CommandResult, GmailRelayPublicStatus, Provider, Settings, Snapshot } from "../shared/contracts";
import { fileSize, formatDate, hostOS, OS_TEXT } from "./utils";
import { BrowserSetup } from "./BrowserSetup";
import { FullMailArchive } from "./FullMailArchive";
import { RefreshControls } from "./RefreshControls";
import { AI_PROVIDER_HELP, activeAi } from "./ai";

type Run = (command: Command, success?: string, onError?: (text: string) => void) => Promise<CommandResult | undefined>;
type Props = { data: Snapshot; run: Run; busy: boolean };
type Tab = "connections" | "assistant" | "data" | "advanced";
type ApiProvider = Exclude<Provider, "whatsapp">;
const providerNames: Record<Provider, string> = { gmail: "Google Workspace", microsoft: "Microsoft 365", slack: "Slack", whatsapp: "WhatsApp Web" };
const tabs: { id: Tab; label: string }[] = [
  { id: "connections", label: "Connections" }, { id: "assistant", label: "AI & assistant" },
  { id: "data", label: "Data & app" }, { id: "advanced", label: "Advanced" }
];

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function SettingsPage({ data, run, busy }: Props) {
  const [tab, setTab] = useState<Tab>("connections");
  return <div className="page settings-page">
    <div className="page-title settings-title"><div><span className="eyebrow">SETTINGS</span><h1>Settings</h1></div></div>
    <div className="settings-tabs" role="tablist" aria-label="Settings sections">
      {tabs.map(item => <button key={item.id} role="tab" type="button" aria-selected={tab === item.id}
        className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <div role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
      {tab === "connections" && <Connections {...{ data, run, busy }}/>}
      {tab === "assistant" && <Assistant {...{ data, run, busy }}/>}
      {tab === "data" && <DataAndApp {...{ data, run, busy }}/>}
      {tab === "advanced" && <Advanced {...{ data, run, busy }}/>}
    </div>
  </div>;
}

/* ---------------------------------------------------------------- Connections */

interface Connection {
  key: string;
  kind: "relay" | "api" | "browser" | "retained";
  account: Account;
  relay?: GmailRelayPublicStatus;
}
interface Mailbox { key: string; label: string; provider: Provider; accounts: Account[]; connections: Connection[] }

const methodRank = { relay: 3, api: 2, browser: 1, retained: 0 } as const;
const methodName = { relay: "Apps Script relay", api: "Provider API", browser: "Browser companion", retained: "Local copies only" } as const;

function mailboxes(data: Snapshot): Mailbox[] {
  const groups = new Map<string, Mailbox>();
  for (const account of data.accounts) {
    const address = account.email.trim().toLowerCase() || account.id;
    const key = `${account.provider}\n${address}${account.demo ? "\ndemo" : ""}`;
    const group = groups.get(key) ?? { key, label: account.email || account.name, provider: account.provider, accounts: [], connections: [] };
    group.accounts.push(account);
    const relays = (data.gmailRelays ?? []).filter(relay => relay.accountId === account.id);
    for (const relay of relays) group.connections.push({ key: `relay:${relay.sourceId}`, kind: "relay", account, relay });
    if (account.connection === "browser") group.connections.push({ key: `browser:${account.id}`, kind: "browser", account });
    else if (account.connection !== "relay") group.connections.push({ key: `api:${account.id}`, kind: "api", account });
    else if (!relays.length) group.connections.push({ key: `retained:${account.id}`, kind: "retained", account });
    groups.set(key, group);
  }
  for (const group of groups.values())
    group.connections.sort((a, b) => methodRank[b.kind] - methodRank[a.kind]);
  return [...groups.values()];
}
function connectionLive(connection: Connection): boolean {
  if (connection.kind === "relay") return !connection.relay?.stopped && connection.account.status === "connected";
  return connection.kind !== "retained" && connection.account.status === "connected";
}
function removeCommand(connection: Connection, forget: boolean): Command {
  return connection.kind === "relay"
    ? { type: "gmailRelay.remove", sourceId: connection.relay!.sourceId, forget }
    : { type: "account.disconnect", accountId: connection.account.id, forget: connection.kind === "retained" ? true : forget };
}

function RemoveConfirm({ what, onConfirm, onCancel, pending, retainedOnly }: {
  what: string; onConfirm: (forget: boolean) => void; onCancel: () => void; pending: boolean; retainedOnly?: boolean;
}) {
  const [forget, setForget] = useState(!!retainedOnly);
  return <div className="delete-confirm compact" role="group" aria-label={`Confirm removing ${what}`}>
    <strong>Remove {what}?</strong>
    {retainedOnly ? <p>This deletes the retained local messages, drafts and indexes. Provider copies are not touched.</p>
      : <label className="checkbox-label"><input type="checkbox" checked={forget} onChange={event => setForget(event.target.checked)}/>
        Also delete its local copies (messages, attachments, indexes). Provider mail is never touched.</label>}
    <div className="button-row"><button className="danger small" disabled={pending} onClick={() => onConfirm(forget)}><Trash2 size={13}/>Remove</button>
      <button className="secondary small" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </div>;
}

function Connections({ data, run, busy }: Props) {
  const groups = mailboxes(data);
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; error: boolean; scope: string }>();
  const [confirm, setConfirm] = useState<string>();
  const [relayTokens, setRelayTokens] = useState<Record<string, string>>({});
  const act = async (scope: string, label: string, commands: Command[], success: string) => {
    setPending(`${scope}:${label}`); setNotice(undefined);
    try {
      let last: CommandResult | undefined;
      for (const command of commands) {
        last = await run(command, undefined, text => setNotice({ text, error: true, scope }));
        if (!last) return undefined;
      }
      setNotice({ text: last?.message || success, error: false, scope });
      setConfirm(undefined);
      return last;
    } finally { setPending(undefined); }
  };
  const working = (scope: string) => pending?.startsWith(`${scope}:`) ?? false;
  const hasRelay = (data.gmailRelays ?? []).length > 0;
  return <>
    <section className="card settings-section" aria-label="Connected mailboxes">
      <div className="settings-heading"><div className="setting-icon"><Plug/></div><div><h2>Your connections</h2>
        <p>One card per mailbox or workspace. Relay Desk reads each mailbox through its best method: Apps Script relay, then provider API, then browser companion. Answers and actions use full messages from the best available method.</p></div></div>
      {!groups.length && <p className="muted">Nothing connected yet. Add a connection below. For Gmail, the Apps Script relay is the recommended method.</p>}
      {groups.map(group => {
        const live = group.connections.filter(connectionLive);
        const primary = live[0];
        const fullMessages = primary && (primary.kind === "relay" || primary.kind === "api");
        const aiAccounts = group.accounts.filter(account => account.status === "connected" && account.consent);
        const aiOn = aiAccounts.length > 0 && aiAccounts.every(account => account.aiEnabled);
        const name = group.accounts[0].name;
        return <article className="mailbox-card account-card" key={group.key} aria-label={`Mailbox ${group.label}`}>
          <div className="account-heading">
            <span className={`provider-icon ${group.provider}`}>{group.provider === "slack" || group.provider === "whatsapp" ? <MessageSquare size={20}/> : <Mail size={20}/>}</span>
            <div><strong>{group.label}</strong><p>{providerNames[group.provider]}{group.accounts.some(account => account.demo) ? " · synthetic" : ""}</p></div>
            <Badge tone={fullMessages ? "teal" : live.length ? "amber" : "rose"}>{fullMessages ? "Full messages" : live.length ? "Previews / loaded pages" : "Not connected"}</Badge>
          </div>
          <div className="setting-row compact"><div><strong>Allow AI</strong><p>Share relevant excerpts from this mailbox's selected sources with your selected AI provider (now {AI_PROVIDER_HELP[activeAi(data).id].title}).</p></div>
            <Toggle label={`Allow ${activeAi(data).name} for ${name}`} checked={aiOn} disabled={!aiAccounts.length || working(group.key)}
              onChange={enabled => void act(group.key, "ai", aiAccounts.filter(account => account.aiEnabled !== enabled)
                .map(account => ({ type: "account.ai", accountId: account.id, enabled })), enabled ? "AI enabled for this mailbox." : "AI disabled for this mailbox.")}/></div>
          {group.accounts.filter(account => account.connection === "browser" && account.provider === "whatsapp").map(account =>
            <div className="setting-row compact" key={`consent:${account.id}`}><div><strong>Allow local capture</strong><p>Retain the loaded text of chats you select. AI sharing stays separate.</p></div>
              <Toggle label={`Allow local capture for ${account.name}`} checked={account.consent} disabled={busy || account.status !== "connected"}
                onChange={enabled => void run({ type: "account.consent", accountId: account.id, enabled }, enabled ? "Local capture allowed. Select the chats to retain." : "Local capture and AI sharing disabled for this account.")}/></div>)}
          <ul className="connection-list" aria-label={`Connection methods for ${group.label}`}>
            {group.connections.map(connection => {
              const { account, relay } = connection;
              const syncJob = data.jobs.filter(job => job.accountId === account.id && job.kind === "sync").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              const syncing = syncJob?.status === "running";
              const expiry = relay?.tokenExpiresAt ? Date.parse(relay.tokenExpiresAt) : NaN;
              const tokenWarning = !!relay && (relay.tokenIsPrevious || (Number.isFinite(expiry) && expiry - Date.now() < 7 * 86400000));
              const isPrimary = connection === primary && live.length > 1;
              return <li key={connection.key} className={`connection-row ${connectionLive(connection) ? "" : "inactive"}`}>
                <div className="connection-main">
                  <div className="connection-title"><strong>{methodName[connection.kind]}</strong>
                    {isPrimary && <Badge tone="teal"><Star size={11}/> primary</Badge>}
                    {connection.kind === "relay" && <Badge tone={relay?.stopped ? "rose" : tokenWarning ? "amber" : syncing ? "" : "teal"}>{relay?.stopped ? "stopped" : syncing ? "syncing" : tokenWarning ? "token warning" : "ready"}</Badge>}
                    {connection.kind !== "relay" && <Badge tone={account.status === "connected" ? "teal" : "amber"}>{connection.kind === "retained" ? "retained" : account.status}</Badge>}
                  </div>
                  <p className="caption">
                    {connection.kind === "relay" && <>Imported {relay!.imported} of {relay!.latestSeq ?? "?"} · last sync {relay!.lastSyncAt ? formatDate(relay!.lastSyncAt, true) : "not yet"} · {relay!.pollIntervalMinutes ? `every ${relay!.pollIntervalMinutes} min` : "manual"}</>}
                    {connection.kind === "api" && <>{account.status === "connected" ? `Last sync ${account.lastSync ? formatDate(account.lastSync, true) : "not yet"}` : "Disconnected · local copies kept and excluded from AI"}</>}
                    {connection.kind === "browser" && <>{account.status === "connected" ? `Loaded-page capture · last ${account.lastSync ? formatDate(account.lastSync, true) : "not yet"}` : "Disconnected · local copies kept and excluded from AI"}</>}
                    {connection.kind === "retained" && <>Connection removed · local copies kept and excluded from AI</>}
                  </p>
                  {syncing && <p className="caption" role="status"><LoaderCircle size={13} className="spin"/> {syncJob.detail || "Importing…"}</p>}
                  {!syncing && syncJob?.status === "failed" && syncJob.detail && connection.kind !== "browser" && <p className="inline-error">Last sync failed: {syncJob.detail}</p>}
                  {relay?.lastError && <p className="inline-error">{relay.lastError}</p>}
                  {account.error && connection.kind !== "relay" && <p className="inline-error">{account.error}</p>}
                  {tokenWarning && <p className="inline-error">{relay!.tokenIsPrevious ? "This token was rotated; paste the new one." : `Token expires ${formatDate(relay!.tokenExpiresAt!, true)}. Rotate it in Apps Script.`}</p>}
                </div>
                <div className="button-row wrap connection-actions">
                  {connection.kind === "relay" && <button className="secondary small" disabled={!!pending || syncing}
                    onClick={() => void act(group.key, connection.key, [{ type: "gmailRelay.sync", sourceId: relay!.sourceId }], "Relay sync started.")}><RefreshCw size={13}/>{syncing ? "Syncing…" : "Sync now"}</button>}
                  {connection.kind === "api" && account.status === "connected" && <button className="secondary small" disabled={busy || syncing}
                    onClick={() => void run({ type: "sync", accountId: account.id }, "Account sync requested.")}><RefreshCw size={13}/>Sync</button>}
                  {connection.kind === "browser" && account.status === "connected" && <button className="secondary small" disabled={busy}
                    onClick={() => void run({ type: "browser.open", kind: account.provider === "whatsapp" ? "whatsapp" : "mail", accountId: account.id })}>Open browser to capture</button>}
                  <button className="danger-text small" disabled={!!pending} aria-label={`Remove ${methodName[connection.kind]} for ${group.label}`}
                    onClick={() => setConfirm(connection.key)}><Trash2 size={13}/>{connection.kind === "retained" || account.status !== "connected" && connection.kind !== "relay" ? "Delete local copies" : "Remove"}</button>
                </div>
                {connection.kind === "relay" && <details className="inline-details"><summary>Replace relay token</summary>
                  <div className="button-row wrap"><input aria-label={`Replacement token for ${relay!.mailbox}`} type="password" autoComplete="off" placeholder="New token from rotateRelayToken()" value={relayTokens[relay!.sourceId] ?? ""} onChange={event => setRelayTokens(value => ({ ...value, [relay!.sourceId]: event.target.value }))}/>
                    <button className="secondary small" disabled={!!pending || !(relayTokens[relay!.sourceId] ?? "").trim()} onClick={async () => {
                      if (await act(group.key, connection.key, [{ type: "gmailRelay.replaceToken", sourceId: relay!.sourceId, token: relayTokens[relay!.sourceId] }], "Relay token replaced."))
                        setRelayTokens(value => ({ ...value, [relay!.sourceId]: "" }));
                    }}>Replace token</button></div></details>}
                {confirm === connection.key && <RemoveConfirm what={`${methodName[connection.kind]} for ${group.label}`} pending={!!pending}
                  retainedOnly={connection.kind === "retained" || (connection.kind !== "relay" && account.status !== "connected")}
                  onCancel={() => setConfirm(undefined)}
                  onConfirm={forget => void act(group.key, connection.key, [removeCommand(connection, forget)], forget ? "Connection removed and local copies deleted." : "Connection removed. Local copies are kept and excluded from AI.")}/>}
              </li>;
            })}
          </ul>
          <SourceList data={data} group={group} run={run} busy={busy}/>
          <div className="button-row wrap mailbox-footer">
            {working(group.key) && <span className="caption" role="status"><LoaderCircle size={13} className="spin"/> Working…</span>}
            {notice?.scope === group.key && <span className={notice.error ? "inline-error" : "caption"} role={notice.error ? "alert" : "status"}>{notice.text}</span>}
            <button className="danger-text small push-right" disabled={!!pending} onClick={() => setConfirm(`all:${group.key}`)}><Trash2 size={13}/>Remove mailbox</button>
          </div>
          {confirm === `all:${group.key}` && <RemoveConfirm what={`all connections for ${group.label}`} pending={!!pending} onCancel={() => setConfirm(undefined)}
            onConfirm={forget => void act(group.key, "all", group.connections.map(connection => removeCommand(connection, forget)),
              forget ? "Mailbox removed and local copies deleted." : "Mailbox connections removed. Local copies kept and excluded from AI.")}/>}
        </article>;
      })}
    </section>
    <section className="card settings-section" aria-label="Add a connection">
      <div className="settings-heading"><div className="setting-icon"><Plus/></div><div><h2>Add a connection</h2><p>Pick one method per mailbox. You can add a second method later as a fallback.</p></div></div>
      <details className="add-method" open={!hasRelay && !data.accounts.length ? true : undefined}>
        <summary><span><Mail size={16}/> Gmail via Apps Script relay</span><Badge tone="teal">Recommended for Gmail</Badge></summary>
        <RelayForm run={run}/>
      </details>
      <details className="add-method">
        <summary><span><Globe size={16}/> Browser companion (Chrome / Edge)</span><small>Gmail, Calendar, WhatsApp · loaded pages</small></summary>
        <BrowserSetup {...{ data, run, busy }}/>
      </details>
      <details className="add-method">
        <summary><span><Plug size={16}/> Provider API</span><small>Gmail OAuth, Microsoft 365, Slack</small></summary>
        <ApiForm {...{ data, run, busy }}/>
      </details>
    </section>
    <section className="card settings-section" aria-label="Refresh and sync">
      <RefreshControls {...{ data, busy, run }}/>
    </section>
  </>;
}

function SourceList({ data, group, run, busy }: { data: Snapshot; group: Mailbox; run: Run; busy: boolean }) {
  const sources = data.sources.filter(source => group.accounts.some(account => account.id === source.accountId));
  if (!sources.length) return group.provider === "whatsapp" ? <p className="caption">No chats discovered. Open WhatsApp Web and use the companion on the chat you want to select.</p> : null;
  const selected = sources.filter(source => source.selected).length;
  return <div className="source-block"><p className="caption">Sources · {selected} of {sources.length} selected. Unselected sources are not imported or shared.</p>
    <div className="source-list">{sources.map(source => {
      const account = group.accounts.find(item => item.id === source.accountId)!;
      return <label key={source.id} className="source-item"><input type="checkbox" checked={source.selected} disabled={busy || account.status !== "connected" || !account.consent}
        onChange={event => void run({ type: "source.select", sourceId: source.id, selected: event.target.checked }, "Source selection updated.")}/>
        {source.kind === "calendar" ? <CalendarDays size={16}/> : source.kind === "channel" || account.provider === "whatsapp" ? <MessageSquare size={16}/> : <Mail size={16}/>}
        <span>{source.name}</span><small>{account.connection === "browser" ? "browser" : account.connection === "relay" || source.name === "Apps Script relay" ? "relay" : "api"} · {source.kind}</small></label>;
    })}</div></div>;
}

function RelayForm({ run }: { run: Run }) {
  const [relay, setRelay] = useState({ url: "", token: "", pollIntervalMinutes: 5, consent: false });
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const relayRun = async (command: Command, label: string, success: string) => {
    setPending(label); setNotice(undefined);
    try {
      const result = await run(command, success, text => setNotice({ text, error: true }));
      if (result) setNotice({ text: result.message || success, error: false });
      return result;
    } finally { setPending(undefined); }
  };
  return <form className="connect-form" aria-label="Add Gmail Apps Script relay" onSubmit={async event => {
    event.preventDefault();
    const command = { type: "gmailRelay.connect" as const, url: relay.url, token: relay.token, pollIntervalMinutes: relay.pollIntervalMinutes, consent: relay.consent };
    if (await relayRun(command, "Validating the relay and adding it…", "Gmail Apps Script relay connected.")) setRelay(value => ({ ...value, token: "" }));
  }}>
    <p className="caption">Complete emails and attachments, no OAuth app needed. Deploy the script as a Web app (Execute as Me), run <code>rotateRelayToken()</code>, then paste the URL and token. Rotate the token at least every 90 days.</p>
    <label>Web app URL<input value={relay.url} onChange={event => setRelay(value => ({ ...value, url: event.target.value }))} placeholder="https://script.google.com/macros/s/.../exec"/></label>
    <label>Relay token<input type="password" autoComplete="off" spellCheck={false} value={relay.token} onChange={event => setRelay(value => ({ ...value, token: event.target.value }))}/></label>
    <label>Poll interval<select value={relay.pollIntervalMinutes} onChange={event => setRelay(value => ({ ...value, pollIntervalMinutes: Number(event.target.value) }))}>
      <option value={0}>Manual only</option><option value={1}>Every 1 minute</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={60}>Every 60 minutes</option>
    </select></label>
    <label className="checkbox-label consent"><input type="checkbox" checked={relay.consent} onChange={event => setRelay(value => ({ ...value, consent: event.target.checked }))}/>I am authorized to import and retain this mailbox locally.</label>
    <div className="button-row wrap">
      <button type="button" className="secondary" disabled={!!pending || !relay.url || !relay.token} onClick={() => void relayRun({ type: "gmailRelay.test", url: relay.url, token: relay.token }, "Testing the relay connection…", "Relay connection OK.")}>Test connection</button>
      <button disabled={!!pending || !relay.consent || !relay.url || !relay.token} type="submit" title={!relay.consent ? "Tick the authorization checkbox first." : undefined}><Plus size={16}/>Add relay</button>
    </div>
    {!pending && relay.url && relay.token && !relay.consent && <p className="caption">Tick the authorization checkbox to enable Add relay.</p>}
    {pending && <p className="caption" role="status"><LoaderCircle size={14} className="spin"/> {pending}</p>}
    {!pending && notice && <p className={notice.error ? "inline-error" : "caption"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
  </form>;
}

function ApiForm({ data, run, busy }: Props) {
  const [provider, setProvider] = useState<ApiProvider>("gmail");
  const [consent, setConsent] = useState(false);
  const secret = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState({ googleClientId: data.settings.googleClientId, microsoftClientId: data.settings.microsoftClientId, microsoftTenant: data.settings.microsoftTenant });
  const connectionJob = data.jobs.filter(job => job.label === `Connect ${provider}`).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const token = secret.current?.value || undefined;
    if (secret.current) secret.current.value = "";
    await run({ type: "account.connect", provider, consent, token }, "Account connection completed. Select its sources above.");
  };
  return <div className="api-connect">
    <form className="connect-form" onSubmit={event => void connect(event)}>
      <label>Provider<select aria-label="API provider" value={provider} onChange={event => { setProvider(event.target.value as ApiProvider); if (secret.current) secret.current.value = ""; setConsent(false); }}>
        {Object.entries(providerNames).filter(([id]) => id !== "whatsapp").map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      {provider !== "microsoft" && <label>{provider === "slack" ? "Authorized Slack user token" : "Google desktop client secret (if required)"}<input key={provider} ref={secret} type="password" autoComplete="off" spellCheck={false} required={provider === "slack"} placeholder={provider === "slack" ? "Workspace-owned internal app user token" : "Optional registration credential"}/></label>}
      <p className="caption">{provider === "slack" ? "Use a workspace-owned internal Slack app's user token. Relay Desk never posts to Slack." : "Save your desktop application ID below first. Connect opens the provider's official sign-in."}</p>
      <label className="checkbox-label consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>I am authorized to import and retain this account's selected data locally. AI sharing remains a separate opt-in.</label>
      <button disabled={busy || !consent} type="submit"><Plus size={16}/>Connect {providerNames[provider]}</button>
    </form>
    {connectionJob && connectionJob.status !== "done" && <div className="account-card" aria-label="Account connection status" role={connectionJob.status === "failed" ? "alert" : "status"}>
      <strong>{providerNames[provider]} connection: {connectionJob.status}</strong>
      <p>{connectionJob.detail || "Waiting for authorization and checking account access."}</p>
    </div>}
    <details className="inline-details"><summary>OAuth application IDs</summary>
      <form onSubmit={event => { event.preventDefault(); void run({ type: "settings.update", patch: config }, "OAuth application configuration saved."); }}>
        <div className="form-grid">
          <label>Google desktop OAuth client ID<input autoComplete="off" value={config.googleClientId} onChange={event => setConfig(value => ({ ...value, googleClientId: event.target.value }))} placeholder="…apps.googleusercontent.com"/></label>
          <label>Microsoft application (client) ID<input autoComplete="off" value={config.microsoftClientId} onChange={event => setConfig(value => ({ ...value, microsoftClientId: event.target.value }))} placeholder="Public desktop application ID"/></label>
          <label>Microsoft tenant<input value={config.microsoftTenant} onChange={event => setConfig(value => ({ ...value, microsoftTenant: event.target.value }))}/></label>
        </div>
        <button type="submit" className="secondary" disabled={busy}>Save application IDs</button>
      </form>
      <p className="caption">Gmail compose permission can technically send mail, but Relay Desk has no send action. Microsoft does not request Mail.Send.</p>
    </details>
  </div>;
}

/* ---------------------------------------------------------------- AI provider & assistant */

function AiProviderSection({ data, run, busy }: Props) {
  const update = (patch: Partial<Settings>, message?: string) => void run({ type: "settings.update", patch }, message || "Settings saved.");
  const { id: active, name } = activeAi(data);
  const providers = data.ai?.providers ?? (["copilot", "claude", "codex"] as const).map(id => id === "copilot"
    ? { id, name: "GitHub Copilot", auth: "subscription" as const, status: data.copilot.status, message: data.copilot.message, hasKey: undefined }
    : { id, name: AI_PROVIDER_HELP[id].title, auth: id === "claude" ? "api-key" as const : "subscription" as const, status: "disconnected" as const, message: "", hasKey: undefined });
  const info = providers.find(item => item.id === active);
  const [claudeKey, setClaudeKey] = useState("");
  const [codexPath, setCodexPath] = useState(data.settings.codexPath ?? "");
  const help = AI_PROVIDER_HELP[active];
  return <section className="card settings-section" aria-label="AI provider">
    <div className="settings-heading"><div className="setting-icon"><Sparkles/></div><div><h2>AI provider</h2><p>Choose who powers chat, drafts and reports. Switch at any time; each provider remembers its own model.</p></div>
      <Badge tone={data.copilot.status === "ready" ? "teal" : "amber"}>{data.copilot.status}</Badge></div>
    <div className="provider-picker" role="radiogroup" aria-label="AI provider">
      {providers.map(item => <button key={item.id} type="button" role="radio" aria-checked={item.id === active} disabled={busy}
        className={`provider-option ${item.id === active ? "active" : ""}`}
        onClick={() => item.id !== active && void run({ type: "ai.provider", provider: item.id })}>
        <strong>{AI_PROVIDER_HELP[item.id].title}</strong>
        <span className="caption">{item.auth === "api-key" ? (item.hasKey ? "Your API key · saved" : "Your API key") : "Subscription sign-in"} · {item.status}</span>
      </button>)}
    </div>
    <p className="muted">{help.detail} {help.billing}</p>
    {info?.message && <p className="muted" role="status">{info.message}</p>}
    {active === "claude" && <form className="limit-form" onSubmit={event => { event.preventDefault(); if (claudeKey.trim()) void run({ type: "ai.claudeKey", key: claudeKey.trim() }).then(() => setClaudeKey("")); }}>
      <label>Anthropic API key<input type="password" autoComplete="off" spellCheck={false} placeholder={info?.hasKey ? "Saved — paste a new key to replace it" : "sk-ant-…"}
        value={claudeKey} onChange={event => setClaudeKey(event.target.value)} aria-label="Anthropic API key"/></label>
      <button className="secondary" disabled={busy || !claudeKey.trim()} type="submit">Save key</button>
      {info?.hasKey && <button type="button" className="secondary danger" disabled={busy} onClick={() => void run({ type: "ai.claudeKey.clear" })}><Trash2 size={15}/>Remove key</button>}
    </form>}
    {active === "codex" && <form className="limit-form" onSubmit={event => { event.preventDefault(); update({ codexPath: codexPath.trim() }, "Codex CLI path saved."); }}>
      <label>Codex CLI path (optional)<input value={codexPath} spellCheck={false} placeholder="Found automatically on PATH" onChange={event => setCodexPath(event.target.value)} aria-label="Codex CLI path"/></label>
      <button className="secondary" disabled={busy} type="submit">Save path</button>
    </form>}
    <div className="button-row wrap">
      {active !== "claude" && <button disabled={busy} onClick={() => void run({ type: "copilot.login" }, `${name} sign-in requested.`)}>Sign in</button>}
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "copilot.connect" }, `${name} connection refreshed.`)}><RefreshCw size={15}/>{data.copilot.status === "ready" ? "Refresh models" : "Connect"}</button>
      <label className="model-select"><Sparkles size={14}/><span className="sr-only">{name} model</span>
        <select aria-label={`${name} model`} value={data.settings.model} disabled={!data.models.length} onChange={event => update({ model: event.target.value })}>
          <option value="">{data.models.length ? "Choose a model" : "Connect for available models"}</option>
          {data.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select></label>
    </div>
  </section>;
}

function Assistant({ data, run, busy }: Props) {
  const update = (patch: Partial<Settings>, message?: string) => void run({ type: "settings.update", patch }, message || "Settings saved.");
  const [limits, setLimits] = useState({ dailyAiLimit: data.settings.dailyAiLimit, attachmentThresholdMb: data.settings.attachmentThresholdMb });
  const tools = data.settings.assistantTools;
  const { name } = activeAi(data);
  return <>
    <AiProviderSection {...{ data, run, busy }}/>
    <section className="card settings-section" aria-label="AI usage">
      <div className="settings-heading"><div className="setting-icon"><RefreshCw/></div><div><h2>AI usage</h2><p>Background help and local limits apply to every provider.</p></div></div>
      <div className="setting-row compact"><div><strong>Background AI assistance</strong><p>Prioritize new messages and prepare local drafts for AI-enabled mailboxes.</p></div>
        <Toggle label="Background AI assistance" checked={data.settings.backgroundAi} disabled={busy} onChange={backgroundAi => update({ backgroundAi })}/></div>
      <div className="setting-row compact"><div><strong>Full access by default</strong><p>New inboxes, channels and calendars are imported and shared with AI as soon as you connect them, with no per-account opt-in. WhatsApp chats stay opt-in. Commands, web requests, calendar changes and sending always still need you.</p></div>
        <Toggle label="Full access by default" checked={data.settings.fullAccessByDefault} disabled={busy} onChange={fullAccessByDefault => update({ fullAccessByDefault })}/></div>
      <form className="limit-form" onSubmit={event => { event.preventDefault(); update(limits); }}>
        <label>Daily AI run limit<input type="number" min={0} max={1000} required value={limits.dailyAiLimit} onChange={event => setLimits(value => ({ ...value, dailyAiLimit: Number(event.target.value) }))}/></label>
        <label>File approval threshold (MB)<input type="number" min={1} max={10000} required value={limits.attachmentThresholdMb} onChange={event => setLimits(value => ({ ...value, attachmentThresholdMb: Number(event.target.value) }))}/></label>
        <button className="secondary" disabled={busy} type="submit">Save limits</button>
      </form>
      <p className="caption">{data.settings.aiRunsToday} app-initiated AI runs today (local counter, not your {name} balance).</p>
    </section>
    <section className="card settings-section" aria-label="Assistant tools">
      <div className="settings-heading"><div className="setting-icon"><Wrench/></div><div><h2>Assistant tools</h2>
        <p>Let chat create files (Word, Excel, PowerPoint, Markdown…), run commands and fetch web pages, like Copilot CLI. Files stay in the workspace folder; commands and web requests always ask you first.</p></div></div>
      <div className="setting-row compact"><div><strong>Enable assistant tools</strong><p>Turn off to keep chat strictly read-only over your communications.</p></div>
        <Toggle label="Enable assistant tools" checked={tools} disabled={busy} onChange={assistantTools => update({ assistantTools })}/></div>
      <div className="setting-row compact"><div><strong><FolderOpen size={14}/> Workspace folder</strong><p className="mono-path">{data.assistantWorkspace || data.settings.assistantWorkspaceDir || OS_TEXT[hostOS()].documents}</p></div>
        <div className="button-row"><button className="secondary small" disabled={busy} onClick={() => void run({ type: "assistant.workspace.choose" })}>Change…</button>
          <button className="quiet small" disabled={busy} onClick={() => void run({ type: "assistant.workspace.open" })}>Open</button></div></div>
      <div className="setting-row compact"><div><strong><Terminal size={14}/> Shell commands</strong><p>{OS_TEXT[hostOS()].shell} commands run in the workspace folder after you approve each one (or allow them for one response).</p></div>
        <select aria-label="Shell commands" value={data.settings.assistantShell} disabled={busy || !tools} onChange={event => update({ assistantShell: event.target.value === "off" ? "off" : "ask" })}>
          <option value="ask">Ask every time</option><option value="off">Off</option></select></div>
      <div className="setting-row compact"><div><strong><Globe size={14}/> Web access</strong><p>Fetching a URL asks you first. Email content can never trigger it on its own.</p></div>
        <select aria-label="Web access" value={data.settings.assistantWeb} disabled={busy || !tools} onChange={event => update({ assistantWeb: event.target.value === "off" ? "off" : "ask" })}>
          <option value="ask">Ask every time</option><option value="off">Off</option></select></div>
    </section>
  </>;
}

/* ---------------------------------------------------------------- Data & app */

function DataAndApp({ data, run, busy }: Props) {
  const update = (patch: Partial<Settings>) => void run({ type: "settings.update", patch }, "Settings saved.");
  const [confirmRestore, setConfirmRestore] = useState(false);
  return <>
    <section className="card settings-section" aria-label="Local archive">
      <div className="settings-heading"><div className="setting-icon"><Database/></div><div><h2>Local archive</h2><p>An encrypted copy on this device. It never moves or deletes original messages.</p></div></div>
      <div className="storage-strip"><strong>{fileSize(data.archive.bytes)}</strong><span>{data.archive.messages.toLocaleString()} messages</span><span>{data.archive.attachments.toLocaleString()} attachments</span><Badge>{data.archive.searchMode}</Badge></div>
      <div className="setting-row compact"><div><strong>Local semantic search</strong><p>Downloads {data.settings.embeddingModel} once and runs embeddings locally. Download and cache sizes are not checked in advance. This is separate from account-level consent to share excerpts with Copilot. Rebuild the index afterwards.</p></div>
        <Toggle label="Local semantic search" checked={data.settings.semanticEnabled} disabled={busy} onChange={semanticEnabled => update({ semanticEnabled })}/></div>
      <div className="button-row wrap">
        <button className="secondary" disabled={busy} onClick={() => void run({ type: "archive.backup" })}><ArrowDownToLine size={15}/>Encrypted backup</button>
        <button className="secondary" disabled={busy} onClick={() => setConfirmRestore(true)}>Restore backup</button>
        <button className="secondary" disabled={busy} onClick={() => void run({ type: "archive.reindex" }, "Reindex requested.")}><RefreshCw size={15}/>Rebuild local index</button>
      </div>
      {confirmRestore && <div className="delete-confirm"><strong>Restore an encrypted backup?</strong><p>Restore may replace your current local archive. Make a backup first.</p>
        <div className="button-row"><button disabled={busy} onClick={async () => { await run({ type: "archive.restore" }); setConfirmRestore(false); }}>Choose backup to restore</button><button className="secondary" onClick={() => setConfirmRestore(false)}>Cancel</button></div></div>}
    </section>
    <section className="card settings-section" aria-label="App behaviour">
      <div className="settings-heading"><div className="setting-icon"><ShieldCheck/></div><div><h2>App behaviour</h2></div></div>
      {([{ key: "syncPaused", title: "Pause synchronization", text: "Stop new imports. Local content stays available." },
        { key: "closeToTray", title: `Keep running in ${OS_TEXT[hostOS()].tray}`, text: "Closing the window keeps Relay Desk running." },
        { key: "startAtLogin", title: `Start at ${OS_TEXT[hostOS()].name} login`, text: "Open Relay Desk when you sign in." },
        { key: "notifications", title: "Desktop notifications", text: "Discreet notices without message text." }] as const).map(({ key, title, text }) =>
        <div className="setting-row compact" key={key}><div><strong>{title}</strong><p>{text}</p></div><Toggle label={title} checked={data.settings[key]} disabled={busy} onChange={value => update({ [key]: value })}/></div>)}
    </section>
    <section className="demo-section"><div><h3>Synthetic workspace</h3><p>Explore the interface with clearly labeled fictional conversations.</p></div>
      <button className="secondary" disabled={busy} onClick={() => void run({ type: data.demo ? "demo.clear" : "demo.load" }, data.demo ? "Synthetic data removed." : "Synthetic demo loaded.")}>{data.demo ? "Remove synthetic demo" : "Load synthetic demo"}</button></section>
  </>;
}

/* ---------------------------------------------------------------- Advanced */

function Advanced({ data, run, busy }: Props) {
  const update = (patch: Partial<Settings>) => void run({ type: "settings.update", patch }, "Settings saved.");
  return <>
    <section className="card settings-section" aria-label="Browser reading method">
      <div className="settings-heading"><div className="setting-icon"><Globe/></div><div><h2>Browser inbox reading</h2>
        <p>Only used for mailboxes without an Apps Script relay or API connection.</p></div></div>
      <label>Read browser inboxes using
        <select value={data.settings.browserMailTransport} disabled={busy}
          onChange={event => update({ browserMailTransport: event.target.value === "companion" ? "companion" : "auto" })}>
          <option value="companion">Direct browser — signed-in Chrome / Edge companion</option>
          <option value="auto">Gmail API first, managed Playwright fallback</option>
        </select></label>
      <p className="caption">Google may reject sign-in inside the managed Playwright browser ("This browser or app may not be secure"). Relay Desk pauses that fallback instead of bypassing it; use the Apps Script relay or Gmail API instead.</p>
      {(data.mailTransports ?? []).map(route => {
        const account = data.accounts.find(item => item.id === route.accountId);
        if (!account || account.demo) return null;
        return <div className="setting-row compact" key={route.accountId}><div><strong>{account.email}</strong>
          <p>{route.transport === "gmail-api" ? "Gmail API" : route.transport === "playwright" ? "Playwright fallback" : route.transport} — {route.message}</p></div>
          {route.transport === "playwright" && <button className="secondary small" disabled={busy || data.settings.syncPaused}
            onClick={() => void run({ type: "browser.playwright.open", accountId: account.id })}>Open fallback / sign in</button>}
        </div>;
      })}
      <p className="caption" role="status">{data.playwrightMail?.error || data.playwrightMail?.message || (data.playwrightMail?.running ? "Managed browser is running." : "Managed browser is closed.")}</p>
      {(data.playwrightMail?.running || data.settings.playwrightMailEnabled) && <button className="secondary small" disabled={busy}
        onClick={() => void run({ type: "browser.playwright.close" })}><X size={13}/>Close browser and pause fallback</button>}
    </section>
    <FullMailArchive {...{ data, run, busy }}/>
  </>;
}

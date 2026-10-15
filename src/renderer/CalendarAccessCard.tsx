import { useRef, useState } from "react";
import { CalendarDays, LoaderCircle, ShieldCheck } from "lucide-react";
import type { Account, Command, CommandResult, Source } from "../shared/contracts";

export function CalendarAccessCard({ account, sources, run, blocked, manageSources, aiName = "Copilot" }: {
  aiName?: string; account: Account; sources: Source[]; blocked: boolean; manageSources: () => void;
  run: (command: Command, success?: string) => Promise<CommandResult | undefined>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const enable = async () => {
    if (!expanded || blocked || lock.current) return;
    lock.current = true; setPending(true); setError("");
    try {
      const result = await run({ type: "account.ai", accountId: account.id, enabled: true });
      if (!result) {
        lock.current = false; setPending(false);
        setError("AI access was not updated. Review Settings or try again.");
      }
    } catch {
      lock.current = false; setPending(false);
      setError("AI access could not be updated. No sources were selected.");
    }
  };
  return <section className="chat-calendar-access" aria-label={`Calendar access for ${account.email || account.name}`}>
    <CalendarDays size={19}/>
    <div className="chat-calendar-access-content">
      <div className="chat-calendar-access-heading"><strong>Calendar access</strong><span>{account.email || account.name}</span></div>
      <p>Local calendar is connected, but not shared with {aiName}.</p>
      {!expanded ? <button type="button" className="text-button" aria-expanded={false} onClick={() => setExpanded(true)}>Review AI access</button> : <div className="chat-access-disclosure">
        <strong><ShieldCheck size={14}/>Enable AI sharing for this account’s selected sources (including mail) with {aiName}</strong>
        <p>This applies to the account, not just this calendar. Relevant content from its selected sources, including messages and attachments, may be sent to cloud {aiName}. Unselected sources and other accounts stay unchanged.</p>
        <p className="chat-access-sources"><span>Currently selected:</span> {sources.map(source => `${source.name} (${source.kind})`).join(" · ")}</p>
        <p>You can choose fewer sources in Settings before enabling. Enabling access does not move any meeting; ask {aiName} again afterward.</p>
        <div className="button-row wrap">
          <button type="button" className="small" disabled={blocked || pending} onClick={() => void enable()}>{pending && <LoaderCircle size={13} className="spin"/>}Enable AI for this account</button>
          <button type="button" className="secondary small" disabled={pending} onClick={() => { setExpanded(false); setError(""); }}>Cancel</button>
          <button type="button" className="text-button" disabled={pending} onClick={manageSources}>Choose sources in Settings</button>
        </div>
        {pending && <p role="status">Updating account AI access…</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>}
    </div>
  </section>;
}

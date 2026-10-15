import { useState } from "react";
import { ArrowRight, Check, Inbox, KeyRound, ListChecks, MessageSquare, Sparkles, X } from "lucide-react";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";
import { hostOS, OS_TEXT } from "./utils";

type Run = (command: Command, success?: string) => Promise<CommandResult | undefined>;
const DISMISSED = "relay.setupGuide.dismissed";

export interface SetupStep { id: string; title: string; detail: string; done: boolean }

/** Setup progress derived only from the snapshot, so it stays correct after restarts and in every window. */
export function setupSteps(data: Snapshot): SetupStep[] {
  const real = data.accounts.filter(account => !account.demo);
  const selected = (accountId: string) => data.sources.some(source => source.accountId === accountId && source.selected);
  const os = OS_TEXT[hostOS()].name;
  return [
    { id: "copilot", title: "Connect your Copilot subscription", done: data.copilot.status === "ready",
      detail: `No API key. Install Copilot CLI, run copilot and /login once on this ${os} account, then connect.` },
    { id: "model", title: "Choose a model", done: !!data.settings.model && data.models.some(model => model.id === data.settings.model),
      detail: "You can switch models at any time, even per question." },
    { id: "inbox", title: "Connect an inbox", done: real.some(account => selected(account.id)),
      detail: "Fastest: the browser companion uses Gmail tabs you already have open. Gmail API, Apps Script relay, Outlook and Slack are optional." },
    { id: "consent", title: "Let Copilot read the sources you choose", done: real.some(account => account.aiEnabled && selected(account.id)),
      detail: "AI access is opt-in per account. Nothing is sent; replies stay drafts." },
    { id: "ask", title: "Ask your first question", done: (data.chat?.conversations ?? []).some(conversation => conversation.turns.length > 0),
      detail: "Try “What needs my attention today?”" }
  ];
}

export interface SetupGuideState { steps: SetupStep[]; visible: boolean; dismiss: () => void }

export function useSetupGuide(data: Snapshot): SetupGuideState {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; } });
  const steps = setupSteps(data);
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISSED, "1"); } catch { /* storage unavailable */ } };
  return { steps, visible: !dismissed && steps.some(step => !step.done), dismiss };
}

export function SetupGuide({ data, guide, run, openSettings, ask }: { data: Snapshot; guide: SetupGuideState; run: Run; openSettings: () => void; ask: (text: string) => void }) {
  const { steps, visible, dismiss } = guide;
  if (!visible) return null;
  const complete = steps.filter(step => step.done).length;
  const next = steps.find(step => !step.done)!;
  const busy = data.copilot.status === "connecting";
  const action = (step: SetupStep) => {
    switch (step.id) {
      case "copilot": return <div className="button-row wrap">
        <button className="small" disabled={busy} onClick={() => void run({ type: "copilot.connect" })}><Sparkles size={14}/>{busy ? "Connecting…" : "Connect Copilot"}</button>
                <button className="small secondary" disabled={busy} onClick={() => void run({ type: "copilot.login" })}><KeyRound size={14}/>Sign in to Copilot</button></div>;
      case "model": return <label className="model-select"><span className="sr-only">Choose a Copilot model</span>
        <select aria-label="Choose a Copilot model" value={data.settings.model} disabled={!data.models.length}
          onChange={event => void run({ type: "settings.update", patch: { model: event.target.value } }, "Model selected.")}>
          <option value="">{data.models.length ? "Choose a model" : "Connect Copilot first"}</option>
          {data.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select></label>;
      case "inbox": case "consent": return <div className="button-row wrap">
        <button className="small" onClick={openSettings}><Inbox size={14}/>{step.id === "inbox" ? "Connect an inbox" : "Choose AI sources"}<ArrowRight size={14}/></button>
        {step.id === "inbox" && !data.demo && <button className="small secondary" onClick={() => void run({ type: "demo.load" }, "Synthetic sample workspace loaded.")}>Explore a sample workspace</button>}</div>;
      default: return <button className="small" onClick={() => ask("What needs my attention today? Cite the evidence and suggest next steps.")}><MessageSquare size={14}/>Try it</button>;
    }
  };
  return <section className="setup-guide" aria-label="Getting started">
    <header><div><span className="eyebrow"><ListChecks size={13}/> GETTING STARTED · {complete} OF {steps.length}</span><h2>Five minutes to a calmer inbox</h2></div>
      <button className="icon-button" aria-label="Hide getting started" title="Hide getting started" onClick={dismiss}><X size={16}/></button></header>
    <div className="setup-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={complete}>
      <span style={{ width: `${(complete / steps.length) * 100}%` }}/></div>
    <ol>{steps.map((step, index) => <li key={step.id} className={step.done ? "done" : step === next ? "current" : ""} aria-current={step === next ? "step" : undefined}>
      <span className="setup-marker" aria-hidden="true">{step.done ? <Check size={13}/> : index + 1}</span>
      <div><strong>{step.title}{step.done && <span className="sr-only"> (done)</span>}</strong>
        {step === next && <><p>{step.detail}</p>{step.id === "copilot" && data.copilot.status === "error" && data.copilot.message && <p className="setup-error" role="status">{data.copilot.message}</p>}{action(step)}</>}</div>
    </li>)}</ol>
  </section>;
}

import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { Command, CommandResult, Snapshot } from "../shared/contracts";

type Run = (command: Command, success?: string) => Promise<CommandResult | undefined>;

/** One-click switch for full access: every assistant action, sensitive or destructive included, runs without asking. */
export function FullAccessButton({ data, run }: { data: Snapshot; run: Run }) {
  const on = data.settings.bypassSafety;
  const toggle = () => {
    if (!on && !window.confirm("Turn on full access?\n\nThe assistant will run every command, file change or deletion, web request and calendar invitation without asking, including actions the safety check flags as sensitive or destructive. You can turn it off at any time.")) return;
    void run({ type: "settings.update", patch: { bypassSafety: !on } }, on ? "Full access is off: sensitive actions ask you again." : "Full access is on: safety checks are bypassed.");
  };
  return <button type="button" role="switch" aria-checked={on} className={`full-access-toggle ${on ? "on" : ""}`} onClick={toggle}
    title={on ? "Full access is on: all safety checks are bypassed. Click to turn off." : "Turn on full access (bypass all safety checks)"}>
    {on ? <ShieldAlert size={13}/> : <ShieldCheck size={13}/>}{on ? "Full access" : "Safe mode"}</button>;
}

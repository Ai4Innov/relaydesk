import type { Command, CommandResult, Snapshot } from "../shared/contracts";

const options = [
  { value: 0, label: "Manual only" },
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 3600, label: "Every hour" },
] as const;

export function RefreshControls({ data, busy, run }: { data: Snapshot; busy: boolean;
  run: (command: Command, success?: string) => Promise<CommandResult | undefined> }) {
  const value = data.settings.refreshIntervalSeconds;
  return <div className="account-card">
    <h3>Workspace refresh controls</h3>
    <p>Refresh selected API channels and re-read loaded Gmail or Calendar pages on your schedule. Enable background browser refresh to keep importing while Relay Desk is in front. Browser sleep or unloaded pages can still delay updates.</p>
    <label className="checkbox-label"><input type="checkbox" checked={data.settings.browserBackgroundCapture} disabled={busy}
      onChange={event => void run({ type: "settings.update", patch: { browserBackgroundCapture: event.target.checked } })}/>
      Refresh selected browser pages in the background</label>
    <p className="caption">Allows reading loaded content from selected, consented sources even when their tabs are hidden. It does not navigate pages, send mail, or change AI consent.</p>
    <div className="button-row wrap">
      <button className="secondary" disabled={busy} onClick={() => void run({ type: "refresh.request" }, "Refresh requested.")}>Refresh now</button>
      <label>
        <span className="caption">Refresh interval</span><br/>
        <select aria-label="Refresh interval" disabled={busy} value={value} onChange={event => {
          const next = Number(event.target.value);
          void run({ type: "settings.update", patch: { refreshIntervalSeconds: next } },
            next === 0 ? "Channels set to manual refresh only." : `Channel refresh set to ${options.find(option => option.value === next)?.label.toLowerCase()}.`);
        }}>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          {!options.some(option => option.value === value) && <option value={value}>Every {value} seconds</option>}
        </select>
      </label>
    </div>
    <p className="caption">{value === 0
      ? "Manual mode keeps discovery active but only captures when you click Refresh now or Capture now."
      : `Selected ${data.settings.browserBackgroundCapture ? "loaded" : "visible"} browser tabs capture on this cadence (${options.find(option => option.value === value)?.label.toLowerCase() ?? `${value} seconds`}).`}</p>
    {data.settings.syncPaused && <p className="inline-error">Sync is paused globally, so manual refresh will not capture content until sync resumes.</p>}
  </div>;
}

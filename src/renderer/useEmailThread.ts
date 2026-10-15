import { useEffect, useState } from "react";
import type { Command, CommandResult, Message, MessageThread, Snapshot } from "../shared/contracts";
import { commandError } from "./utils";
import { compareRecentMessages } from "../shared/inbox";

export function useEmailThread(data: Snapshot, current: Message | undefined,
  run: (command: Command) => Promise<CommandResult | undefined>) {
  const account = data.accounts.find(item => item.id === current?.accountId);
  const source = data.sources.find(item => item.id === current?.sourceId);
  const allowed = !!current && !!account?.consent && account.status === "connected" && !!source?.selected
    && source.accountId === account.id && !current.deleted;
  const canLoad = allowed && account.connection === "browser" && account.provider === "gmail" && !!current?.browser;
  const key = current?.id || "";
  const [retry, setRetry] = useState({ key: "", count: 0 });
  const [state, setState] = useState<{ key: string; loading: boolean; result?: MessageThread; error?: string }>();
  const refresh = retry.key === key && retry.count > 0;
  useEffect(() => {
    if (!canLoad || !key) { setState(undefined); return; }
    let active = true;
    setState({ key, loading: true });
    void run({ type: "message.load", messageId: key, ...(refresh ? { refresh: true } : {}) }).then(response => {
      if (!active) return;
      const result = response?.messageThread;
      if (!result || result.accountId !== account.id || result.sourceId !== source.id
        || result.threadId !== current.threadId || !result.messages.length) {
        setState({ key, loading: false, error: "Full email could not be loaded. Check the connection notice above, then retry." });
      } else setState({ key, loading: false, result });
    }, error => {
      if (active) setState({ key, loading: false, error: commandError(error) });
    });
    return () => { active = false; };
  }, [key, canLoad, account?.id, source?.id, current?.threadId, retry, refresh, run]);
  const visibleState = allowed && state?.key === key ? state : undefined;
  const archived = allowed ? data.messages.filter(item => item.accountId === current.accountId
    && item.sourceId === current.sourceId && item.threadId === current.threadId && !item.deleted) : [];
  const available = visibleState?.result?.messages || archived;
  const full = available.filter(item => !item.browser || item.browser.completeness === "full");
  const thread = (full.length ? full : available).slice().sort((a, b) => compareRecentMessages(b, a));
  const attachments = visibleState?.result?.attachments.map(item => data.attachments.find(latest => latest.id === item.id) || item)
    || data.attachments;
  return {
    thread, attachments, canLoad, loading: canLoad && (!visibleState || visibleState.loading),
    error: visibleState?.error, loadedAt: visibleState?.result?.loadedAt,
    reload: () => setRetry(previous => ({ key, count: previous.key === key ? previous.count + 1 : 1 })),
    replyMessage: current && data.drafts.some(draft => draft.messageId === current.id) ? current : thread.at(-1) || current,
  };
}

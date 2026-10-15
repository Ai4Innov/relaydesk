import type { Account, Attachment, Message, Source } from "../../shared/contracts";
import { HttpClient, ProviderError, emptyPage, hash, id, list, number, optionalObject, query, required, source, text, trustedUrl,
  type Json, type OnPage, type Vault } from "./core";

export const SLACK_BASE = "https://slack.com/api/";
export const SLACK_SCOPES = ["channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history",
  "mpim:read", "mpim:history", "users:read", "files:read"];
interface SlackCursor { latest?: string; next?: string; oldest?: string; fullScanAt?: number; scanning?: boolean; seenRoots?: string[] }
function check(data: Json): Json {
  if (data.ok !== true) {
    const error = text(data.error);
    throw new ProviderError(400, /^[a-z_]{1,64}$/.test(error) ? error : "slack_error");
  }
  return data;
}
function slackMessage(account: Account, selected: Source, data: Json, historical: boolean): { message: Message; attachments: Attachment[] } {
  const timestamp = required(data.ts);
  const providerId = `${selected.providerId}:${timestamp}`;
  const thread = text(data.thread_ts, timestamp);
  const team = account.id.split(":")[1];
  const message: Message = { id: id(account.id, "message", providerId), accountId: account.id, sourceId: selected.id, providerId,
    threadId: id(account.id, "thread", `${selected.providerId}:${thread}`), subject: `${selected.name} · ${text(data.user, "Slack")}`,
    sender: text(data.user) || text(data.username, "Slack"), recipients: [], body: text(data.text),
    receivedAt: new Date(Number(timestamp) * 1000).toISOString(),
    url: `https://app.slack.com/client/${encodeURIComponent(team ?? "")}/${encodeURIComponent(selected.providerId)}/thread/${encodeURIComponent(selected.providerId)}-${encodeURIComponent(thread)}`,
    unread: false, revision: text(optionalObject(data.edited).ts) || hash(JSON.stringify(data)), historical,
    deleted: data.subtype === "message_deleted" };
  const attachments = list(data.files).map(file => {
    const providerId = required(file.id);
    const external = file.is_external === true || file.mode === "external";
    return { id: id(account.id, "attachment", `${selected.providerId}:${timestamp}:${providerId}`), accountId: account.id, messageId: message.id,
      providerId, name: text(file.name, providerId), mimeType: text(file.mimetype, "application/octet-stream"), size: number(file.size),
      status: external ? "blocked" as const : "pending" as const,
      ...(external ? { reason: "External file requires a separately authorized connector" } : {}) };
  });
  return { message, attachments };
}
export class SlackConnector {
  constructor(private readonly http: HttpClient, private readonly vault: Vault) {}
  async identity(): Promise<{ id: string; name: string }> {
    const response = await this.http.response("auth.test");
    const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map(scope => scope.trim());
    if (SLACK_SCOPES.some(scope => !scopes.includes(scope))) throw new Error(`Slack user token requires these read scopes: ${SLACK_SCOPES.join(", ")}`);
    const data = check(optionalObject(await response.json()));
    if (data.bot_id) throw new Error("Use an authorized Slack user token, not a bot token");
    return { id: `${required(data.team_id)}:${required(data.user_id)}`, name: `${text(data.team)} · ${text(data.user)}` };
  }
  private async api(method: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<Json> {
    return check(await this.http.json(query(method, params), { signal }));
  }
  async discover(account: Account): Promise<Source[]> {
    const result: Source[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api("users.conversations", { types: "public_channel,private_channel,mpim,im", exclude_archived: "false", limit: "200", cursor });
      for (const channel of list(page.channels)) result.push(source(account, required(channel.id),
        text(channel.name) || (text(channel.user) ? `Direct message · ${text(channel.user)}` : required(channel.id)), "channel"));
      cursor = text(optionalObject(page.response_metadata).next_cursor) || undefined;
    } while (cursor);
    return result;
  }
  async sync(account: Account, selected: Source, onPage: OnPage, signal?: AbortSignal): Promise<void> {
    if (selected.kind !== "channel") throw new Error("Unsupported Slack source");
    const checkpointId = id(account.id, "checkpoint", selected.id);
    const prior = this.vault.get<SlackCursor>("checkpoints", checkpointId) ?? {};
    const historical = !prior.latest;
    const fullScan = !prior.latest || !prior.fullScanAt || Date.now() - prior.fullScanAt >= 86400000;
    const cursor: SlackCursor = prior.scanning ? { ...prior } : {
      latest: prior.latest, oldest: fullScan ? undefined : String(Math.max(0, Number(prior.latest) - 86400)), fullScanAt: prior.fullScanAt, scanning: true,
    };
    const roots = new Set(cursor.seenRoots ?? []);
    let newest = cursor.latest ?? "0";
    do {
      const page = await this.api("conversations.history", { channel: selected.providerId, limit: "100", cursor: cursor.next, oldest: cursor.oldest }, signal);
      const result = emptyPage();
      for (const value of list(page.messages)) {
        if (!text(value.ts)) continue;
        const incoming = slackMessage(account, selected, value, historical);
        result.messages.push(incoming.message);
        result.attachments.push(...incoming.attachments);
        roots.add(required(value.ts));
        if (Number(value.ts) > Number(newest)) newest = required(value.ts);
      }
      cursor.next = text(optionalObject(page.response_metadata).next_cursor) || undefined;
      if (page.has_more === true && !cursor.next) throw new Error("Slack pagination incomplete; no continuation cursor");
      result.checkpoint = { id: checkpointId, value: { ...cursor, seenRoots: [...roots] } };
      await onPage(result);
    } while (cursor.next);

    // Revisit every known thread, not just threads whose parent falls in the recent
    // history window. This finds replies and edits on old conversations.
    const archived = this.vault.all<Message>("messages").filter(message => message.accountId === account.id && message.sourceId === selected.id && !message.deleted);
    const threads = new Set([...roots]);
    for (const message of archived) {
      const prefix = `${account.id}:thread:`;
      if (message.threadId.startsWith(prefix)) {
        const thread = decodeURIComponent(message.threadId.slice(prefix.length));
        if (thread.startsWith(`${selected.providerId}:`)) threads.add(thread.slice(selected.providerId.length + 1));
      }
    }
    for (const timestamp of threads) {
      signal?.throwIfAborted();
      let next: string | undefined;
      const seen = new Set<string>();
      try {
        do {
          const page = await this.api("conversations.replies", { channel: selected.providerId, ts: timestamp, limit: "100", cursor: next }, signal);
          const result = emptyPage();
          for (const value of list(page.messages)) {
            const incoming = slackMessage(account, selected, value, historical);
            seen.add(incoming.message.id);
            result.messages.push(incoming.message);
            result.attachments.push(...incoming.attachments);
          }
          next = text(optionalObject(page.response_metadata).next_cursor) || undefined;
          if (page.has_more === true && !next) throw new Error("Slack thread pagination incomplete");
          await onPage(result);
        } while (next);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== "thread_not_found") throw error;
      }
      const deleted = archived.filter(message => message.threadId === id(account.id, "thread", `${selected.providerId}:${timestamp}`) && !seen.has(message.id));
      if (deleted.length) await onPage({ ...emptyPage(), messages: deleted.map(message => ({ ...message, deleted: true })) });
    }
    await onPage(emptyPage({ id: checkpointId, value: { latest: newest, fullScanAt: cursor.oldest ? prior.fullScanAt : Date.now() } }));
  }
  async downloadAttachment(attachment: Attachment, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const data = await this.api("files.info", { file: attachment.providerId }, signal);
    const file = optionalObject(data.file);
    if (file.is_external === true || file.mode === "external") throw new Error("External Slack files require a separately authorized connector");
    const url = required(file.url_private_download || file.url_private);
    trustedUrl(url, SLACK_BASE, true);
    const response = await this.http.response(url, { signal }, true);
    if (!response.body) throw new Error("Slack returned no file body");
    return response.body;
  }
}

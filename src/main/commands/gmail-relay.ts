import type { Account, CommandResult, Source } from "../../shared/contracts";
import { GMAIL_RELAY_PROVIDER_ID, GMAIL_RELAY_STATUS_PREFIX, type GmailRelaySecret, type GmailRelayState } from "../connectors/gmail-relay";
import { id as providerId } from "../connectors/core";
import { normalizeEmail, now, type CommandContext, type CommandOf } from "./context";
import { fullAccessByDefault } from "../access";

/** Gmail Apps Script relay: validate, connect, rotate token, remove and trigger imports. */
export async function gmailRelayCommand(ctx: CommandContext, command: CommandOf<"gmailRelay.">): Promise<CommandResult> {
  const { vault } = ctx;
  const relayState = (sourceId: string) => vault.get<GmailRelayState>("checkpoints", `${GMAIL_RELAY_STATUS_PREFIX}${sourceId}`);
  switch (command.type) {
    case "gmailRelay.test": {
      const status = await ctx.connectors.testGmailRelay(command.url, command.token);
      return { message: `Relay connection OK for ${status.mailbox ?? "the mailbox"}. Export status: ${status.status ?? "unknown"}.` };
    }
    case "gmailRelay.connect": {
      if (!command.consent) throw new Error("Confirm local archival permission before enabling the Gmail Apps Script relay.");
      const status = await ctx.connectors.testGmailRelay(command.url, command.token);
      if (!status.mailbox) throw new Error("The relay did not report a mailbox.");
      const mailboxName = status.mailbox;
      const mailbox = normalizeEmail(mailboxName);
      const accountId = `gmail:${mailbox}`;
      const existing = vault.get<Account>("accounts", accountId);
      const siblingAi = vault.all<Account>("accounts").some(account => account.provider === "gmail"
        && normalizeEmail(account.email) === mailbox && account.aiEnabled && account.consent && account.status === "connected");
      const full = fullAccessByDefault(vault);
      const account: Account = { ...(existing ?? { id: accountId, provider: "gmail" as const, name: status.mailbox, email: status.mailbox,
        status: "connected" as const, aiEnabled: siblingAi || full, consent: true, connection: "relay" as const }),
        status: "connected", consent: true, error: undefined,
        aiEnabled: existing?.aiEnabled ?? (siblingAi || full), connection: existing?.connection ?? "relay" };
      const sourceId = providerId(account.id, "mail", GMAIL_RELAY_PROVIDER_ID);
      const source: Source = vault.get<Source>("sources", sourceId) ?? {
        id: sourceId, accountId: account.id, providerId: GMAIL_RELAY_PROVIDER_ID, name: "Apps Script relay", kind: "mail", selected: true
      };
      const secret: GmailRelaySecret = { url: command.url, token: command.token, mailbox: mailboxName, pollIntervalMinutes: command.pollIntervalMinutes };
      vault.transaction(() => {
        vault.put("accounts", account.id, account);
        vault.put("sources", source.id, { ...source, selected: true });
        ctx.connectors.configureGmailRelay(secret, source.id);
        const previous = relayState(source.id);
        vault.put("checkpoints", `${GMAIL_RELAY_STATUS_PREFIX}${source.id}`, {
          sourceId: source.id, mailbox: mailboxName, cursor: previous?.cursor ?? 0, imported: previous?.imported ?? 0,
          lastStatusAt: now(), exportStatus: status.status, phase: status.phase, latestSeq: status.latestSeq,
          tokenExpiresAt: status.tokenExpiresAt ?? null, tokenIsPrevious: status.tokenIsPrevious, updatedAt: status.updatedAt ?? now()
        } satisfies GmailRelayState);
      });
      ctx.changed();
      return { message: `Gmail Apps Script relay connected for ${mailboxName}. Its token is stored in the encrypted local credential store and is never returned to the renderer.` };
    }
    case "gmailRelay.replaceToken": {
      const relay = ctx.relayStatuses().find(item => item.sourceId === command.sourceId);
      if (!relay) throw new Error("Gmail Apps Script relay connection not found.");
      const source = vault.get<Source>("sources", command.sourceId);
      if (!source) throw new Error("Gmail Apps Script relay source not found.");
      const old = vault.get<GmailRelaySecret>("secrets", `gmail-relay:${source.id}`);
      if (!old) throw new Error("Gmail Apps Script relay credentials are unavailable.");
      const status = await ctx.connectors.testGmailRelay(old.url, command.token);
      if (!status.mailbox || normalizeEmail(status.mailbox) !== normalizeEmail(old.mailbox))
        throw new Error("The replacement token belongs to a different mailbox.");
      await ctx.connectors.configureGmailRelay({ ...old, token: command.token }, source.id);
      vault.put("checkpoints", `${GMAIL_RELAY_STATUS_PREFIX}${source.id}`, { ...(relayState(source.id) ??
        { sourceId: source.id, mailbox: old.mailbox, cursor: 0, imported: 0 }), stopped: false, lastError: undefined,
        lastStatusAt: now(), exportStatus: status.status, phase: status.phase, latestSeq: status.latestSeq,
        tokenExpiresAt: status.tokenExpiresAt ?? null, tokenIsPrevious: status.tokenIsPrevious, updatedAt: status.updatedAt ?? now() } satisfies GmailRelayState);
      ctx.changed();
      return { message: "Gmail Apps Script relay token replaced after validation." };
    }
    case "gmailRelay.remove": {
      const source = vault.get<Source>("sources", command.sourceId);
      if (!source) throw new Error("Gmail Apps Script relay source not found.");
      ctx.cancelAccount(source.accountId);
      ctx.connectors.removeGmailRelay(source.id);
      vault.delete("sources", source.id);
      if (command.forget && !vault.all<Source>("sources").some(item => item.accountId === source.accountId)) {
        ctx.chat.forgetAccount(source.accountId);
        ctx.retrieval.forgetAccount(source.accountId);
        ctx.productivity.forgetAccount(source.accountId);
        vault.purgeAccount(source.accountId);
      }
      ctx.chat.permissionsChanged();
      ctx.changed();
      return { message: command.forget ? "Gmail Apps Script relay removed and local data forgotten where it was the only source." : "Gmail Apps Script relay removed. Retained local data is excluded with the source." };
    }
    case "gmailRelay.sync": {
      const relays = ctx.relayStatuses().filter(relay => !command.sourceId || relay.sourceId === command.sourceId);
      if (!relays.length) throw new Error("Configure a Gmail Apps Script relay first.");
      if (ctx.settings().syncPaused) throw new Error("Synchronization is paused in Settings.");
      let started = 0, running = 0;
      for (const relay of relays) {
        const source = vault.get<Source>("sources", relay.sourceId);
        if (!source) continue;
        if (ctx.startRelaySync(relay.accountId, source) === "running") running++;
        else started++;
      }
      if (!started && running) return { message: "A relay sync is already in progress. Progress is shown in the relay row." };
      return { message: "Gmail Apps Script relay sync started. Messages appear as each batch of 10 is imported." };
    }
  }
}

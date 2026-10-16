import type { Account, Command, CommandResult, Source } from "../../shared/contracts";
import { demoData } from "../demo";
import type { CommandContext } from "./context";
import { fullAccessByDefault } from "../access";

type AccountCommand = Extract<Command, { type: "demo.load" | "demo.clear" | "account.connect" | "account.disconnect" | "account.consent" | "account.ai" | "source.select" }>;

/** Account, consent, source-selection and synthetic-demo lifecycle. */
export async function accountCommand(ctx: CommandContext, command: AccountCommand): Promise<CommandResult> {
  const { vault } = ctx;
  switch (command.type) {
    case "demo.load": {
      const data = demoData();
      vault.transaction(() => {
        for (const collection of ["accounts", "sources", "messages", "actions", "events", "attachments", "drafts"] as const)
          for (const record of data[collection]) vault.put(collection, record.id, record);
      });
      for (const message of data.messages) await ctx.retrieval.indexMessage(message);
      ctx.changed();
      return { message: "Synthetic sample workspace loaded. No real accounts were connected." };
    }
    case "demo.clear": {
      for (const account of vault.all<Account>("accounts").filter(a => a.demo)) {
        ctx.chat.forgetAccount(account.id);
        ctx.retrieval.forgetAccount(account.id);
        ctx.productivity.forgetAccount(account.id);
        vault.purgeAccount(account.id);
      }
      ctx.chat.permissionsChanged();
      ctx.changed();
      return { message: "Sample data removed." };
    }
    case "account.connect": {
      if (!command.consent) throw new Error("Confirm that you are authorized to archive these communications before connecting.");
      return ctx.runJob("sync", `Connect ${command.provider}`, async () => {
        const result = await ctx.connectors.connect(command.provider, ctx.settings(), command.token);
        const full = fullAccessByDefault(vault);
        const known = vault.get<Account>("accounts", result.account.id);
        vault.transaction(() => {
          vault.put("accounts", result.account.id, { ...result.account, consent: true, aiEnabled: full && (known?.aiEnabled ?? true) });
          for (const source of result.sources) {
            const previous = vault.get<Source>("sources", source.id);
            vault.put("sources", source.id, { ...source, selected: previous?.selected ?? full });
          }
          const available = new Set(result.sources.map(source => source.id));
          for (const source of vault.all<Source>("sources"))
            if (source.accountId === result.account.id && !available.has(source.id))
              vault.put("sources", source.id, { ...source, selected: false });
        });
        ctx.changed();
        return { message: full ? "Account connected with full access: all folders, channels and calendars are imported and available to AI. Narrow this any time in Settings." : "Account connected. Select the folders, channels and calendars to import." };
      });
    }
    case "account.disconnect": {
      ctx.cancelAccount(command.accountId);
      if (vault.get<Account>("accounts", command.accountId)?.connection !== "browser")
        await ctx.connectors.disconnect(command.accountId);
      const account = vault.get<Account>("accounts", command.accountId);
      if (!account) throw new Error("Account not found.");
      if (command.forget) ctx.chat.forgetAccount(account.id);
      vault.put("accounts", account.id, { ...account, status: "disconnected", aiEnabled: false });
      ctx.chat.permissionsChanged();
      ctx.retrieval.forgetAccount(account.id);
      if (command.forget) {
        ctx.productivity.forgetAccount(account.id);
        vault.purgeAccount(account.id);
        if (account.connection === "browser") {
          const id = `browser-forgotten:${account.id}`;
          vault.put("checkpoints", id, { id, accountId: account.id });
        }
      }
      ctx.changed();
      return { message: command.forget ? "Account and local derived data removed. Provider copies are unchanged." : "Disconnected. Retained local content is excluded from retrieval and AI." };
    }
    case "account.consent": {
      const account = vault.get<Account>("accounts", command.accountId);
      if (!account || account.status !== "connected")
        throw new Error("Connect this account before changing its data-access consent.");
      ctx.cancelAccount(account.id);
      vault.put("accounts", account.id, {
        ...account, consent: command.enabled, aiEnabled: command.enabled ? account.aiEnabled : false
      });
      ctx.chat.permissionsChanged();
      ctx.changed();
      return { message: command.enabled
        ? "Local data access enabled. Choose individual sources to import; AI permission is separate."
        : "Local data access and AI disabled. Retained content is excluded until you grant access again." };
    }
    case "account.ai": {
      const account = ctx.account(command.accountId);
      vault.put("accounts", account.id, { ...account, aiEnabled: command.enabled });
      ctx.chat.permissionsChanged();
      ctx.changed();
      return { message: command.enabled ? "AI enabled for this account. Relevant excerpts may be sent to your selected AI provider." : "AI disabled for this account." };
    }
    case "source.select": {
      const source = vault.get<Source>("sources", command.sourceId);
      if (!source) throw new Error("Source not found.");
      ctx.cancelAccount(source.accountId);
      vault.put("sources", source.id, { ...source, selected: command.selected });
      ctx.chat.permissionsChanged();
      ctx.changed();
      return { message: command.selected
        ? vault.get<Account>("accounts", source.accountId)?.connection === "browser"
          ? "Source enabled. Open its signed-in browser tab to capture loaded content."
          : "Source enabled. Sync to import its history."
        : "Source excluded from ingestion, retrieval and AI." };
    }
  }
}

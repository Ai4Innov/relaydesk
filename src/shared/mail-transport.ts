import type { Account, Collection, Message, Source } from "./contracts";

export interface GmailApiOrigin { accountId: string; sourceId: string }
export interface MailTransportStatus {
  accountId: string;
  transport: "gmail-api" | "playwright" | "companion" | "unavailable";
  apiAccountId?: string;
  message: string;
}
export interface PlaywrightMailStatus { running: boolean; message?: string; error?: string }

export function mailOriginAllowed(vault: { get<T>(collection: Collection, id: string): T | undefined },
  message: Pick<Message, "accountId" | "gmailApi">, ai = false): boolean {
  if (!message.gmailApi) return true;
  const account = vault.get<Account>("accounts", message.gmailApi.accountId);
  const owner = vault.get<Account>("accounts", message.accountId);
  const source = vault.get<Source>("sources", message.gmailApi.sourceId);
  return !!account && !!owner && account.provider === "gmail" && account.connection !== "browser"
    && account.status === "connected" && account.consent && (!ai || account.aiEnabled)
    && account.email.trim().toLowerCase() === owner.email.trim().toLowerCase()
    && !!source?.selected && source.kind === "mail" && source.accountId === account.id;
}

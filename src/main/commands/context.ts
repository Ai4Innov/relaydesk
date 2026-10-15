import type { Account, Command, Job, Settings, Snapshot, Source } from "../../shared/contracts";
import type { Vault } from "../storage/vault";
import type { ConnectorHub } from "../connectors";
import type { Retrieval } from "../retrieval";
import type { ProductivityService } from "../productivity";
import type { ChatService } from "../chat";
import type { BrowserBridge } from "../browser/bridge";

export const now = () => new Date().toISOString();
export const normalizeEmail = (value: string) => value.trim().toLowerCase();

/** Narrow view of RelayService used by domain command handlers. */
export interface CommandContext {
  vault: Vault;
  connectors: ConnectorHub;
  retrieval: Retrieval;
  productivity: ProductivityService;
  chat: ChatService;
  changed(): void;
  settings(): Settings;
  /** Abort sync, downloads and attachment work for an account whose permissions changed. */
  cancelAccount(accountId: string): void;
  relayStatuses(): NonNullable<Snapshot["gmailRelays"]>;
  runJob<T>(kind: Job["kind"], label: string, task: (job: Job) => Promise<T>, accountId?: string): Promise<T>;
  /** Starts a background relay import unless the account is already syncing. */
  startRelaySync(accountId: string, source: Source): "started" | "running";
  account(id: string): Account;
  selectedSource(id: string, accountId: string): Source;
  requireAi(accountId: string): Account;
  browser(): BrowserBridge | undefined;
  /** True while shutting down, restoring an archive, or when automation is paused. */
  automationUnavailable(): boolean;
  /** Registers an in-flight job so archive restore and shutdown wait for it. */
  trackJob(jobId: string, active: boolean): void;
}

export type CommandOf<Prefix extends string> = Extract<Command, { type: `${Prefix}${string}` }>;

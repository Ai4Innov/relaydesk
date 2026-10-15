import { describe, expect, it, vi } from "vitest";
import type { Account, Collection, Source } from "../src/shared/contracts";
import { MailFreshness } from "../src/main/browser/mail-freshness";
import type { BrowserMailReader } from "../src/main/browser/mail-reader";
import { GMAIL_RELAY_PROVIDER_ID } from "../src/main/connectors/gmail-relay";

function memoryVault(records: Partial<Record<Collection, Record<string, unknown>>>) {
  return {
    get: <T>(collection: Collection, id: string) => records[collection]?.[id] as T | undefined,
    all: <T>(collection: Collection) => Object.values(records[collection] ?? {}) as T[],
    put: <T>(collection: Collection, id: string, value: T) => { (records[collection] ??= {})[id] = value; }
  };
}
const account = (id: string, connection: Account["connection"]): Account => ({ id, provider: "gmail", name: "Me", email: "Me@Example.com",
  status: "connected", aiEnabled: true, consent: true, connection });

describe("mail freshness relay priority", () => {
  const browser = account("browser:me", "browser"), relay = account("gmail:me@example.com", "relay");
  const browserSource: Source = { id: "browser:me:mail", accountId: browser.id, providerId: "inbox", name: "Inbox", kind: "mail", selected: true };
  const relaySource: Source = { id: "gmail:me@example.com:relay", accountId: relay.id, providerId: GMAIL_RELAY_PROVIDER_ID, name: "Apps Script relay", kind: "mail", selected: true };
  const setup = (syncImpl: () => Promise<number>) => {
    const vault = memoryVault({ accounts: { [browser.id]: browser, [relay.id]: relay }, sources: { [browserSource.id]: browserSource, [relaySource.id]: relaySource } });
    const sync = vi.fn(syncImpl);
    const inbox = vi.fn(async () => ({ messages: [] }) as never);
    const capture = vi.fn(async () => undefined);
    const freshness = new MailFreshness(vault, { reader: {} as BrowserMailReader, revision: () => 1, unavailable: () => undefined, manual: () => false,
      busy: () => {}, sync, inbox, capture });
    return { freshness, sync, inbox };
  };

  it("refreshes a browser mailbox through its Apps Script relay and skips browser capture", async () => {
    const { freshness, sync, inbox } = setup(async () => 3);
    const result = await freshness.refresh({ sourceId: browserSource.id, force: true, signal: new AbortController().signal, progress: () => {} });
    expect(sync).toHaveBeenCalledTimes(1);
    expect((sync.mock.calls[0] as unknown[])[1]).toMatchObject({ id: relaySource.id });
    expect(inbox).not.toHaveBeenCalled();
    expect(result.status).toBe("fresh");
    expect(result.sources).toEqual([expect.objectContaining({ sourceId: relaySource.id, downloaded: 3 })]);
  });

  it("falls back to browser capture when the relay fails", async () => {
    const { freshness, sync, inbox } = setup(async () => { throw new Error("Relay token rejected."); });
    const result = await freshness.refresh({ sourceId: browserSource.id, force: true, signal: new AbortController().signal, progress: () => {} });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(result.sources.map(source => source.sourceId)).toEqual([relaySource.id, browserSource.id]);
    expect(result.sources[0]).toMatchObject({ status: "unavailable", reason: "Relay token rejected." });
  });
});

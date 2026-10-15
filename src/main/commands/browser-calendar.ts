import { randomUUID } from "node:crypto";
import type { Command, CommandResult, Job } from "../../shared/contracts";
import type { BrowserCalendarItem } from "../../shared/browser";
import { buildCalendarWorkspace } from "../../shared/calendar";
import { browserCalendarRevision } from "../browser/calendar-revision";
import { commandSchema } from "../ipc/schema";
import { safeError } from "../errors";
import { now, type CommandContext } from "./context";

/**
 * Reschedules a captured Google Calendar meeting through the paired browser companion.
 * Every step re-validates account, source, AI consent and the reviewed event revision before the visible UI is changed.
 */
export async function moveBrowserCalendarEvent(ctx: CommandContext, command: Extract<Command, { type: "browser.calendar.move" }>,
  beforeWrite?: () => void): Promise<CommandResult> {
  const { vault } = ctx;
  if (!beforeWrite) throw new Error("Confirm the exact browser-calendar action card in Chat before moving a meeting.");
  const parsed = commandSchema.parse(command);
  if (parsed.type !== "browser.calendar.move") throw new Error("Invalid browser calendar move.");
  const item = vault.get<BrowserCalendarItem>("browserItems", parsed.itemId);
  if (!item) throw new Error("The captured browser meeting is unavailable.");
  const account = ctx.account(item.accountId);
  const source = ctx.selectedSource(item.sourceId, account.id);
  ctx.requireAi(account.id);
  if (account.demo || account.connection !== "browser" || account.provider !== "gmail" || source.kind !== "calendar")
    throw new Error("Choose a connected Google browser calendar.");
  const bridge = ctx.browser();
  if (!bridge?.status().paired) throw new Error("Pair the updated browser companion before moving a calendar event.");
  const date = new Date(`${parsed.newDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== parsed.newDate || parsed.endTime <= parsed.startTime)
    throw new Error("Choose a valid date and a same-day end after the start time.");
  try { new Intl.DateTimeFormat("en", { timeZone: parsed.timeZone }).format(date); }
  catch { throw new Error("Choose a valid IANA calendar time zone."); }
  const prefix = `${account.id}:meeting:`;
  if (!item.id.startsWith(prefix)) throw new Error("Browser meeting provenance is invalid.");
  const providerId = decodeURIComponent(item.id.slice(prefix.length));
  if (!providerId || providerId.length > 512 || /[\u0000-\u001f]/.test(providerId))
    throw new Error("Browser meeting identity is invalid.");
  const guard = () => {
    if (ctx.automationUnavailable()) throw new Error("Browser calendar actions are paused.");
    ctx.account(account.id); ctx.requireAi(account.id); ctx.selectedSource(source.id, account.id);
    const current = vault.get<BrowserCalendarItem>("browserItems", item.id);
    if (!current || browserCalendarRevision(current) !== parsed.expectedRevision)
      throw new Error("The captured meeting changed. Review a new proposal before saving.");
    beforeWrite();
  };
  guard();
  const title = buildCalendarWorkspace({ accounts: [account], sources: [source], events: [], browserItems: [item] },
    { includePast: true }).entries[0]?.title || item.title;
  const job: Job = { id: randomUUID(), kind: "calendar", accountId: account.id, label: "Move reviewed meeting in browser",
    status: "running", progress: 0, createdAt: now(), updatedAt: now() };
  vault.put("jobs", job.id, job); ctx.trackJob(job.id, true); ctx.changed();
  try {
    const result = await bridge.moveCalendarEvent({
      accountId: account.id, accountEmail: account.email, itemId: item.id, providerId,
      expectedTitle: title, expectedWhenText: item.whenText, newDate: parsed.newDate,
      startTime: parsed.startTime, endTime: parsed.endTime, timeZone: parsed.timeZone,
      notificationPolicy: "provider-default", expiresAt: new Date(Date.now() + 120000).toISOString(),
      proofRevision: parsed.expectedRevision
    }, guard);
    vault.put("jobs", job.id, { ...job, status: result.status === "saved" ? "done" : result.status === "needs-user" ? "paused" : "failed",
      progress: result.status === "saved" ? 100 : 0, detail: result.message, updatedAt: now() });
    if (result.status === "saved") bridge.requestRefresh();
    return { message: result.message, browserCalendarOutcome: result.status };
  } catch (error) {
    vault.put("jobs", job.id, { ...job, status: "failed", detail: safeError(error), updatedAt: now() });
    throw error;
  } finally { ctx.trackJob(job.id, false); ctx.changed(); }
}

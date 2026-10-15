import { z } from "zod";
import { absoluteFolder, host } from "../platform";
import { productivitySchemas } from "./productivity-schema";
import { CHAT_MESSAGE_MAX } from "../../shared/chat";
import { ACCOUNT_LINK_ERROR, ACCOUNT_LINK_MAX_LENGTH, parseBrowserAccountLink } from "../../shared/browser-account-link";

const id = z.string().min(1).max(2048);
const text = z.string().max(100000);
const address = z.string().trim().email().max(320);
const eventChange = z.object({
  accountId: id,
  sourceId: id,
  eventId: id.optional(),
  title: z.string().trim().min(1).max(1000),
  start: z.string().min(1).max(100),
  end: z.string().min(1).max(100),
  timeZone: z.string().min(1).max(100),
  allDay: z.boolean(),
  attendees: z.array(address).max(100),
  location: z.string().max(2000),
  description: text,
  reminderMinutes: z.number().int().min(0).max(40320).optional(),
  expectedRevision: z.string().max(2048).optional()
}).strict();
const settingsPatch = z.object({
  model: z.string().max(200).optional(),
  codexPath: z.string().max(1000).refine(value => value === "" || absoluteFolder(value), `Use an absolute ${host.name} path to the Codex CLI.`).optional(),
  dailyAiLimit: z.number().int().min(1).max(1000).optional(),
  backgroundAi: z.boolean().optional(),
  syncPaused: z.boolean().optional(),
  browserBackgroundCapture: z.boolean().optional(),
  browserFullMailDownload: z.boolean().optional(),
  browserAttachmentDownload: z.boolean().optional(),
  browserMailTransport: z.enum(["auto", "companion"]).optional(),
  startAtLogin: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  notifications: z.boolean().optional(),
  refreshIntervalSeconds: z.number().int().refine(value => value === 0 || (value >= 30 && value <= 3600), "Choose manual refresh (0), or 30-3600 seconds.").optional(),
  attachmentThresholdMb: z.number().positive().max(1000000).optional(),
  semanticEnabled: z.boolean().optional(),
  embeddingModel: z.enum(["Xenova/multilingual-e5-small"]).optional(),
  googleClientId: z.string().max(500).optional(),
  microsoftClientId: z.string().max(100).optional(),
  microsoftTenant: z.string().regex(/^[a-zA-Z0-9.-]+$/).max(200).optional(),
  assistantTools: z.boolean().optional(),
  assistantWorkspaceDir: z.string().max(500).refine(value => value === "" || absoluteFolder(value), `Use an absolute ${host.name} folder path.`).optional(),
  assistantShell: z.enum(["ask", "off"]).optional(),
  assistantWeb: z.enum(["ask", "off"]).optional()
}).strict();
const relayUrl = z.string().trim().min(1).max(2000).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" && !url.username && !url.password && !url.port
      && /^\/(?:macros\/s\/[^/]+\/exec|a\/macros\/[^/]+\/s\/[^/]+\/exec)$/.test(url.pathname);
  } catch { return false; }
}, "Use the HTTPS Apps Script web app URL on script.google.com.");
const relayToken = z.string().trim().min(1).max(5000);
export const commandSchema = z.discriminatedUnion("type", [
  ...productivitySchemas,
  z.object({ type: z.literal("chat.new") }).strict(),
  z.object({ type: z.literal("chat.send"), conversationId: id.optional(), text: z.string().min(1).max(CHAT_MESSAGE_MAX).refine(value => !!value.trim(), "Write a message."), model: z.string().min(1).max(200).optional(), mailRefresh: z.enum(["download", "local"]).optional() }).strict(),
  z.object({ type: z.literal("chat.confirm"), conversationId: id, turnId: id, actionId: id }).strict(),
  z.object({ type: z.literal("chat.cancel") }).strict(),
  z.object({ type: z.literal("chat.delete"), conversationId: id }).strict(),
  z.object({ type: z.literal("chat.permission"), conversationId: id, turnId: id, requestId: id, decision: z.enum(["once", "chat", "deny"]) }).strict(),
  z.object({ type: z.literal("chat.openFile"), conversationId: id, turnId: id, path: z.string().min(1).max(1000), reveal: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("assistant.workspace.open") }).strict(),
  z.object({ type: z.literal("assistant.workspace.choose") }).strict(),
  z.object({ type: z.literal("demo.load") }).strict(),
  z.object({ type: z.literal("demo.clear") }).strict(),
  z.object({ type: z.literal("browser.pair"), consent: z.boolean() }).strict(),
  z.object({ type: z.literal("browser.revoke") }).strict(),
  z.object({ type: z.literal("browser.extension") }).strict(),
  z.object({ type: z.literal("browser.playwright.open"), accountId: id }).strict(),
  z.object({ type: z.literal("browser.playwright.close") }).strict(),
  z.object({ type: z.literal("browser.open"), kind: z.enum(["mail", "calendar", "add-account", "whatsapp"]), accountId: id.optional() }).strict(),
  z.object({ type: z.literal("browser.open-link"), url: z.string().max(ACCOUNT_LINK_MAX_LENGTH)
    .refine(value => Boolean(parseBrowserAccountLink(value).link), ACCOUNT_LINK_ERROR) }).strict(),
  z.object({ type: z.literal("browser.meeting"), itemId: id }).strict(),
  z.object({
    type: z.literal("browser.calendar.move"), itemId: id,
    newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1).max(100),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  z.object({ type: z.literal("account.connect"), provider: z.enum(["gmail", "microsoft", "slack"]), token: z.string().max(5000).optional(), consent: z.boolean() }).strict(),
  z.object({ type: z.literal("gmailRelay.test"), url: relayUrl, token: relayToken }).strict(),
  z.object({ type: z.literal("gmailRelay.connect"), url: relayUrl, token: relayToken, pollIntervalMinutes: z.number().int().min(0).max(60), consent: z.boolean() }).strict(),
  z.object({ type: z.literal("gmailRelay.replaceToken"), sourceId: id, token: relayToken }).strict(),
  z.object({ type: z.literal("gmailRelay.remove"), sourceId: id, forget: z.boolean() }).strict(),
  z.object({ type: z.literal("gmailRelay.sync"), sourceId: id.optional() }).strict(),
  z.object({ type: z.literal("account.disconnect"), accountId: id, forget: z.boolean() }).strict(),
  z.object({ type: z.literal("account.ai"), accountId: id, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("account.consent"), accountId: id, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("source.select"), sourceId: id, selected: z.boolean() }).strict(),
  z.object({ type: z.literal("sync"), accountId: id.optional() }).strict(),
  z.object({ type: z.literal("refresh.request") }).strict(),
  z.object({ type: z.literal("settings.update"), patch: settingsPatch }).strict(),
  z.object({ type: z.literal("copilot.connect") }).strict(),
  z.object({ type: z.literal("copilot.login") }).strict(),
  z.object({ type: z.literal("ai.provider"), provider: z.enum(["copilot", "claude", "codex"]) }).strict(),
  z.object({ type: z.literal("ai.claudeKey"), key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, "Paste an Anthropic API key (starts with sk-ant-).") }).strict(),
  z.object({ type: z.literal("ai.claudeKey.clear") }).strict(),
  z.object({ type: z.literal("draft.generate"), messageId: id, instruction: z.string().max(4000).optional(), model: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal("draft.edit"), draftId: id, body: text, recipients: z.array(address).max(100), subject: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("draft.save"), draftId: id }).strict(),
  z.object({ type: z.literal("draft.handoff"), draftId: id, body: text, recipients: z.array(address).max(100), subject: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("action.update"), actionId: id, status: z.enum(["open", "done", "snoozed", "waiting"]), snoozedUntil: z.string().datetime().optional() }).strict(),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(4000), accountId: id.optional() }).strict(),
  z.object({ type: z.literal("ask"), query: z.string().trim().min(1).max(4000), accountId: id.optional(), model: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal("attachment.process"), attachmentId: id, approved: z.boolean() }).strict(),
  z.object({ type: z.literal("attachment.import"), attachmentId: id, approved: z.boolean() }).strict(),
  z.object({ type: z.literal("attachment.download"), attachmentId: id, approved: z.boolean() }).strict(),
  z.object({ type: z.literal("attachment.view"), attachmentId: id }).strict(),
  z.object({ type: z.literal("attachment.save"), attachmentId: id }).strict(),
  z.object({ type: z.literal("calendar.propose"), change: eventChange }).strict(),
  z.object({ type: z.literal("calendar.approve"), approvalId: id, hash: z.string().length(64) }).strict(),
  z.object({ type: z.literal("open.message"), messageId: id }).strict(),
  z.object({ type: z.literal("message.load"), messageId: id, refresh: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("message.downloadAll") }).strict(),
  z.object({ type: z.literal("clipboard.copy"), text }).strict(),
  z.object({ type: z.literal("job.retry"), jobId: id }).strict(),
  z.object({ type: z.literal("archive.backup") }).strict(),
  z.object({ type: z.literal("archive.restore") }).strict(),
  z.object({ type: z.literal("archive.reindex") }).strict()
]);

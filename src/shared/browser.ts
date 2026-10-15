export const BROWSER_BRIDGE_PORT = 43891;
export type BrowserKind = "edge" | "chrome" | "unknown";
export interface BrowserRegistration {
  /** Google email or the verified WhatsApp own-profile E.164 phone number. */
  accountEmail: string;
  accountName: string;
  pageUrl: string;
  kind: "mail" | "calendar" | "whatsapp";
  chat?: { id: string; name: string };
}
export interface BrowserAccess {
  accountId: string;
  enabled: boolean;
  backgroundCapture?: boolean;
  refreshIntervalSeconds?: number;
  refreshRequestedAt?: number;
}
export interface BrowserMail {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  recipients: string[];
  body: string;
  html?: string;
  receivedAt?: string;
  dateText: string;
  url: string;
  unread: boolean;
  completeness: "preview" | "full";
  attachments?: BrowserAttachment[];
  /** Version of the native Gmail attachment manifest inspection; omitted means unverified. */
  attachmentManifestVersion?: 1;
}
export interface BrowserAttachment {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}
export interface BrowserMeeting {
  id: string;
  title: string;
  whenText: string;
  description: string;
  location: string;
  meetingUrl?: string;
  url: string;
}
export interface BrowserCapture extends BrowserRegistration {
  messages: BrowserMail[];
  meetings: BrowserMeeting[];
  /** Accepted only as the result of an authorized one-shot attachment read. */
  attachmentDownload?: { metadataId: string; name: string; relativePath: string; bytes: number; downloadId?: number };
}
export interface BrowserCalendarItem extends BrowserMeeting {
  accountId: string;
  sourceId: string;
  capturedAt: string;
}
export interface BrowserStatus {
  running: boolean;
  paired: boolean;
  port: number;
  lastCapture?: string;
  error?: string;
  clients?: Array<{
    id: string;
    browser: BrowserKind;
    lastSeenAt?: string;
    discoveredAccountIds?: string[];
    calendarActions?: {
      protocol: 1;
      lastSeenAt: string;
      ready: boolean;
    };
  }>;
}
export interface BrowserPairing { code: string; expiresAt: string; port: number }

/** An immutable, user-reviewed move of one captured Google Calendar event. */
export interface BrowserCalendarMove {
  accountId: string;
  accountEmail: string;
  itemId: string;
  providerId: string;
  expectedTitle: string;
  expectedWhenText: string;
  newDate: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  notificationPolicy: "provider-default";
  expiresAt: string;
  proofRevision: string;
}

export type BrowserCalendarResultCode =
  | "saved" | "busy" | "expired" | "unavailable" | "account-mismatch"
  | "event-not-found" | "event-changed" | "unsupported-editor"
  | "time-zone-unverified" | "recurring-event" | "permission-denied"
  | "authorization-denied" | "notification-confirmation" | "save-unverified";

export interface BrowserCalendarResult {
  status: "saved" | "needs-user" | "uncertain";
  code: BrowserCalendarResultCode;
  message: string;
  requestId: string;
}

interface BrowserCalendarJob {
  protocol: 1;
  requestId: string;
  lease: string;
  move: BrowserCalendarMove;
}

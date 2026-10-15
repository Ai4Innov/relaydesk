export interface MailFreshnessRequest {
  accountId?: string;
  sourceId?: string;
  force: boolean;
  signal: AbortSignal;
  progress(text: string): void;
}
export interface MailFreshnessResult {
  status: "fresh" | "partial" | "unavailable";
  checkedAt: string;
  sources: Array<{
    accountId: string;
    sourceId: string;
    status: "fresh" | "partial" | "unavailable";
    checkedAt?: string;
    downloaded: number;
    pending: number;
    reason?: string;
  }>;
  limitation: string;
}

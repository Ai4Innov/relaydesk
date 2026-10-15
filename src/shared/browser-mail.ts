/** A local, on-demand read; never grants AI access or authorizes mail mutations. */
export interface BrowserMailRequest {
  accountId: string;
  accountEmail: string;
  threadId: string;
  /** A leased, owned-tab native inbox refresh, not a conversation read. */
  inboxRefresh?: true;
  messageProviderId?: string;
  attachment?: {
    metadataId: string;
    name: string;
    maxBytes: number;
    /** Explicit download approval permits unknown size; it never overrides maxBytes. */
    approved?: boolean;
    /** Set only by an explicitly approved desktop command. Actual-byte limits still apply. */
    allowUnknownSize?: boolean;
    /** Server-owned path relative to the browser's default Downloads directory. */
    relativePath: string;
  };
}

/** Dispatch metadata only: never a URL, message body, thread ID, or read authorization. */
export interface BrowserMailPendingHint {
  requestId: string;
  accountId: string;
  accountEmail: string;
  expiresAt: number;
  state: "pending" | "waking" | "leased" | "reading";
}

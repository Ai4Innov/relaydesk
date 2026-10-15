/** Converts an unknown failure to a bounded, user-displayable message with credentials redacted. */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The operation failed.";
  return message.replace(/(?:xox[baprs]-|gh[opusr]_|github_pat_)[\w-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "******").slice(0, 1500);
}

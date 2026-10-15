import { z } from "zod";

const browserAttachmentSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(512).refine(name =>
    name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name), "Invalid attachment filename."),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export const browserAttachmentsSchema = z.array(browserAttachmentSchema).max(100)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate attachment identifiers.");

import { z } from "zod";
import { objectId } from "../../common/http.js";

/** Alfred's thread id is opaque to us: only a path-safe token is accepted. */
export const threadParams = z
  .object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid identifier") })
  .strict();
export const threadListQuery = z
  .object({
    unreadOnly: z.enum(["true", "false"]).default("false"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const messagesQuery = z
  .object({
    memberId: objectId,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
/** 2000 is Alfred's own message ceiling. */
export const sendBody = z
  .object({
    memberId: objectId,
    body: z.string().trim().min(1).max(2000),
    // One per draft: Alfred dedupes a retried send on it.
    messageRef: z.string().uuid(),
  })
  .strict();
export const readBody = z.object({ memberId: objectId }).strict();

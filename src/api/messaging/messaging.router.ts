import { Router } from "express";
import { secured } from "../../common/http.js";
import {
  messagesQuery,
  readBody,
  sendBody,
  threadListQuery,
  threadParams,
} from "./messaging.schema.js";
import {
  listMessages,
  listThreads,
  markRead,
  sendMessage,
  unreadCount,
} from "./messaging.service.js";

/** Staff inbox over Alfred's partner messaging. Nothing is stored here (pass-through only). */
export const messagingRouter = Router();
const records = (level: "view" | "edit") => ({ module: "MEMBER_RECORDS", level }) as const;
const r = messagingRouter;

secured(r, "get", "/messaging/threads", records("view"), { query: threadListQuery }, (req) =>
  listThreads(req, req.query as never)
);
secured(r, "get", "/messaging/unread-count", records("view"), {}, (req) => unreadCount(req));
secured(
  r,
  "get",
  "/messaging/threads/:threadId/messages",
  records("view"),
  { params: threadParams, query: messagesQuery },
  (req) => listMessages(req, req.params["threadId"] as string, req.query as never)
);
secured(
  r,
  "post",
  "/messaging/threads/:threadId/messages",
  records("edit"),
  { params: threadParams, body: sendBody },
  (req) => sendMessage(req, req.params["threadId"] as string, req.body),
  201
);
secured(
  r,
  "post",
  "/messaging/threads/:threadId/read",
  records("edit"),
  { params: threadParams, body: readBody },
  (req) => markRead(req, req.params["threadId"] as string, req.body)
);

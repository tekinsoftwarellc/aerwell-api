import type { Request } from "express";
import { actor } from "../../common/http.js";
import { memberTarget, permissionsOf } from "../member/member.scope.js";
import { permits } from "../role/permission.js";
import { readAlfredHealthIntake } from "./healthIntake.client.js";

export async function readMemberHealthIntake(req: Request) {
  req.res?.setHeader("Cache-Control", "no-store");
  const permissions = await permissionsOf(req);
  const detail = permits(permissions.HEALTH_INTAKE.level, "view");
  const member = await memberTarget(req, { modules: detail ? ["HEALTH_INTAKE"] : [] });
  if (!member.alfredAccountId || member.alfredUnlinkedAt)
    return { intake: null, reason: "MEMBER_NOT_LINKED" };
  return readAlfredHealthIntake(member.alfredAccountId, String(actor(req)._id), detail);
}

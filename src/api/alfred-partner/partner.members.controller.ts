import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { audit } from "../audit/audit.js";
import { provisionAlfredMember } from "../member/alfredMember.service.js";
import type { provisionBody } from "./partner.schema.js";

/** `POST /members` (§5.1): 201 on create, 200 on re-provision. Replies carry the ref only, never the profile. */
export async function provisionMember(req: Request, res: Response): Promise<void> {
  const body = req.body as z.output<typeof provisionBody>;
  if (body.accountId !== req.partner?.accountId)
    throw new BadRequestError("accountId must match the acting member");
  if (!env.AERWELL_ORG_ID) throw new UnauthorizedError("Partner organization is not configured");
  const { member, created } = await provisionAlfredMember(env.AERWELL_ORG_ID, {
    accountId: body.accountId,
    ...body.profile,
    ...(body.baseLocationRef ? { baseLocationRef: body.baseLocationRef } : {}),
  });
  const ref = String(member._id);
  await audit(req, created ? "provisioned" : "reprovisioned", "Member", ref, ref);
  const status = created ? 201 : 200;
  res
    .status(status)
    .json(ServiceResponse.success("Member provisioned", { partnerRef: ref, created }, status));
}

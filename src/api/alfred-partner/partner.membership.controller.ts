import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { audit } from "../audit/audit.js";
import { recordAlfredMembership } from "../member/alfredMembership.service.js";
import type { membershipBody } from "./partner.schema.js";

/**
 * `POST /members/{accountId}/membership` (§5.2). The member must already exist (404 from
 * `resolveActingMember`, which makes Alfred provision and retry once). Record only: no plan,
 * ledger or entitlement row is written.
 */
export async function setMembership(req: Request, res: Response): Promise<void> {
  const body = req.body as z.output<typeof membershipBody>;
  if (req.params["accountId"] !== req.partner?.accountId)
    throw new BadRequestError("accountId must match the acting member");
  const member = req.partnerMember;
  if (!member) throw new BadRequestError("Acting member missing");
  const stored = await recordAlfredMembership(member._id, body);
  const ref = String(member._id);
  await audit(req, "membership_recorded", "Member", ref, ref);
  res.json(ServiceResponse.success("Membership set", { partnerRef: ref, ...stored }));
}

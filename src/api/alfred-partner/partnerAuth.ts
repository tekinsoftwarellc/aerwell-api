import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppError, NotFoundError, UnauthorizedError } from "../../common/errors/AppError.js";
import { getAlfredKeyProvider } from "../../common/utils/alfredJwks.js";
import { env } from "../../config/env.js";
import { Member } from "../member/member.model.js";
import { contractForbidden, contractUnprocessable } from "./partner.errors.js";

/** The only caller of the partner surface (contract §2.2 rule 6). */
const ALFRED_SVC = "alfred-api";
const READ_SCOPE = "partner.read";
const CLOCK_TOLERANCE_SECONDS = 60;
const SUPPORTED_CONTRACT_VERSION = 1;
const BAD_TOKEN = "Invalid or expired service token";

export interface PartnerActor {
  readonly svc: string;
  /** `act.sub` of a verified member delegation. Absent on org-level calls. */
  readonly accountId?: string;
}
declare global {
  namespace Express {
    interface Request {
      partner?: PartnerActor;
      /** The acting member, set by `resolveActingMember`. */
      partnerMember?: InstanceType<typeof Member>;
    }
  }
}

interface ServiceTokenPayload extends jwt.JwtPayload {
  realm?: string;
  svc?: string;
  scope?: string;
  act?: { sub?: unknown; realm?: unknown; orgId?: unknown };
}

/** Contract version: required (400) and must be 1 (422). Fail loud rather than misread a new field. */
export function requireContractVersion(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers["x-contract-version"];
  const version = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!raw || !Number.isInteger(version)) {
    next(new AppError("x-contract-version header is required", 400));
    return;
  }
  if (version !== SUPPORTED_CONTRACT_VERSION) {
    next(contractUnprocessable("CONTRACT_VERSION_UNSUPPORTED", "Unsupported contract version"));
    return;
  }
  res.setHeader("x-contract-version", String(SUPPORTED_CONTRACT_VERSION));
  next();
}

const keyFor = async (kid: string): Promise<string> => {
  try {
    return await getAlfredKeyProvider()(kid);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // The signing keys could not be fetched: our fault, and nothing was processed.
    throw new AppError("Signing keys are unavailable", 503);
  }
};

/**
 * The ten verification rules of contract §2.2, in order. RS256 only, key by `kid`, issuer,
 * audience, realm, svc, scope, 60 s clock tolerance, then `act.orgId`, then trust `act`.
 * A sibling of staff `authenticate`, never a companion: staff tokens are HS256 and fail rule 1.
 */
export async function alfredServiceAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("No token provided");
    const token = header.slice(7);
    const decoded = jwt.decode(token, { complete: true });
    // 1. RS256 only. 2. `kid` selects the key.
    if (!decoded || decoded.header.alg !== "RS256" || !decoded.header.kid)
      throw new UnauthorizedError(BAD_TOKEN);
    const publicKey = await keyFor(decoded.header.kid);
    let payload: ServiceTokenPayload;
    try {
      // 3 issuer, 4 audience, 8 clock tolerance (and the signature).
      payload = jwt.verify(token, publicKey, {
        algorithms: ["RS256"],
        issuer: "alfred-auth",
        audience: env.ALFRED_PARTNER_AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }) as ServiceTokenPayload;
    } catch {
      throw new UnauthorizedError(BAD_TOKEN);
    }
    // 5 realm, 6 svc.
    if (payload.realm !== "service" || payload.svc !== ALFRED_SVC)
      throw new UnauthorizedError(BAD_TOKEN);
    // 7 scope.
    if (!(payload.scope ?? "").split(" ").includes(READ_SCOPE))
      throw new AppError("Service token is missing the required scope", 403);
    // 9 `act.orgId` must be Alfred's org for Aerwell. Unset config fails closed.
    const act = payload.act;
    if (act && (!env.ALFRED_PARTNER_ORG_ID || act.orgId !== env.ALFRED_PARTNER_ORG_ID))
      throw contractForbidden("ORG_MISMATCH", "The token acts for a different organization");
    // 10 only now is `act` trusted.
    const accountId =
      act && act.realm === "member" && typeof act.sub === "string" && act.sub ? act.sub : undefined;
    req.partner = { svc: ALFRED_SVC, ...(accountId ? { accountId } : {}) };
    next();
  } catch (error) {
    next(error);
  }
}

/** A member route needs the delegation claim. Absent is 401 (§2.2); on org pulls it is ignored. */
export function requireMemberAct(req: Request, _res: Response, next: NextFunction): void {
  if (!req.partner?.accountId) {
    next(new UnauthorizedError("Service token is missing the required act claim"));
    return;
  }
  next();
}

/** The acting member by Alfred account id. Unknown, archived or unlinked is a plain 404 (§5.1). */
export async function resolveActingMember(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const organizationId = env.AERWELL_ORG_ID;
    const accountId = req.partner?.accountId;
    if (!(organizationId && accountId)) throw new UnauthorizedError("Missing delegation");
    const member = await Member.findOne({
      organizationId,
      alfredAccountId: accountId,
      archivedAt: null,
      alfredUnlinkedAt: null,
    });
    if (!member) throw new NotFoundError("Member not found");
    req.partnerMember = member;
    next();
  } catch (error) {
    next(error);
  }
}

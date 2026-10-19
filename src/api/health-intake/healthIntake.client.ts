import { AppError } from "../../common/errors/AppError.js";
import { ALFRED_TIMEOUT_MS, getServiceToken } from "../../common/services/serviceTokenClient.js";
import { env } from "../../config/env.js";

/** No answer cache: withdrawal and role changes must take effect on the next read. */
export async function readAlfredHealthIntake(accountId: string, staffId: string, detail: boolean) {
  const baseUrl = env.ALFRED_API_INTERNAL_URL;
  if (!baseUrl) throw new AppError("Alfred health intake is unavailable", 503);
  try {
    const token = await getServiceToken("alfred-api", "health_intake.read");
    const response = await fetch(
      `${baseUrl}/internal/member-profiles/${encodeURIComponent(accountId)}/health-intake`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-health-intake-staff-id": staffId,
          "x-health-intake-detail": String(detail),
          "Cache-Control": "no-store",
        },
        signal: AbortSignal.timeout(ALFRED_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      if (response.status === 404) throw new AppError("Linked member is unavailable", 404);
      throw new AppError("Alfred health intake is unavailable", 503);
    }
    const body = (await response.json()) as {
      responseObject?: { intake?: unknown };
      data?: { intake?: unknown };
    };
    const intake = body.responseObject?.intake ?? body.data?.intake;
    if (!intake || typeof intake !== "object" || Array.isArray(intake))
      throw new AppError("Alfred health intake is unavailable", 503);
    const view = intake as Record<string, unknown>;
    const authorization = view["authorization"] as { state?: unknown } | undefined;
    if (detail && authorization?.state === "authorized" && view["detailsRestricted"] === false)
      return { intake };
    const progress = view["progress"] as Record<string, unknown> | undefined;
    return {
      intake: {
        questionnaireVersion: view["questionnaireVersion"],
        revision: view["revision"],
        status: view["status"],
        dashboardCardVisible: view["dashboardCardVisible"],
        startedAt: view["startedAt"],
        completedAt: view["completedAt"],
        progress: progress
          ? {
              total: progress["total"],
              answered: progress["answered"],
              skipped: progress["skipped"],
              remaining: progress["remaining"],
            }
          : undefined,
        authorization: { state: authorization?.state },
        detailsRestricted: true,
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Do not log upstream bodies, tokens, URLs, or health answers.
    throw new AppError("Alfred health intake is unavailable", 503);
  }
}

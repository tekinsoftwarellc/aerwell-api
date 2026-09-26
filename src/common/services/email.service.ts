import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "../../config/env.js";
import { AppError } from "../errors/AppError.js";
export const emailConfigured = () =>
  Boolean(env.AWS_REGION && env.SES_FROM_EMAIL && env.ADMIN_BASE_URL);
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  if (!emailConfigured())
    throw new AppError(
      "Email delivery is not configured",
      503,
      true,
      undefined,
      "EMAIL_UNAVAILABLE"
    );
  const client = new SESClient({ region: env.AWS_REGION });
  try {
    await client.send(
      new SendEmailCommand({
        Source: env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [input.to] },
        Message: { Subject: { Data: input.subject }, Body: { Text: { Data: input.text } } },
      }),
      { abortSignal: AbortSignal.timeout(10_000) }
    );
  } catch {
    throw new AppError("Email delivery is unavailable", 503, true, undefined, "EMAIL_UNAVAILABLE");
  } finally {
    client.destroy();
  }
}

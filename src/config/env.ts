import dotenv from "dotenv";
import { z } from "zod";

if (process.env["NODE_ENV"] !== "test") dotenv.config();

export const envObject = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  HOST: z.string().min(1).default("0.0.0.0"),
  MONGODB_URI: z.string().min(1),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3200"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  ALFRED_API_INTERNAL_URL: z.string().url().optional(),
  ALFRED_AUTH_URL: z.string().url().optional(),
  ALFRED_AUTH_JWKS_URL: z.string().url().optional(),
  ALFRED_AUTH_CLIENT_ID: z.string().optional(),
  ALFRED_AUTH_CLIENT_SECRET: z.string().optional(),
  STAFF_JWT_SECRET: z.string().min(32).optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  SES_FROM_EMAIL: z.string().email().optional(),
  ADMIN_BASE_URL: z.string().url().optional(),
  AERWELL_ORG_ID: z.string().optional(),
  // Payments stay unconfigured until both Stripe keys are supplied (W5).
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  // W9 visit transcription and next-step suggestions. AWS only (BAA): Transcribe
  // Medical streaming, and Bedrock through `us.` cross-region inference profiles.
  // Absent values leave the feature explicitly unconfigured.
  TRANSCRIBE_REGION: z.string().min(1).optional(),
  BEDROCK_REGION: z.string().min(1).optional(),
  BEDROCK_MODEL_FAST: z.string().startsWith("us.").optional(),
  BEDROCK_MODEL_SMART: z.string().startsWith("us.").optional(),
});
export const envSchema = envObject
  .refine((value) => value.NODE_ENV !== "production" || !value.CORS_ORIGIN.includes("*"), {
    path: ["CORS_ORIGIN"],
    message: "Production CORS must use explicit origins",
  })
  // Without these, production would boot with sign-in answering 503 and no notification jobs.
  .refine((value) => value.NODE_ENV !== "production" || value.STAFF_JWT_SECRET, {
    path: ["STAFF_JWT_SECRET"],
    message: "Production requires a staff signing key",
  })
  .refine((value) => value.NODE_ENV !== "production" || value.AERWELL_ORG_ID, {
    path: ["AERWELL_ORG_ID"],
    message: "Production requires the Aerwell organization id",
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Report names only: Zod messages can contain raw enum inputs or credentials.
  throw new Error(
    `Invalid environment keys: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`
  );
}
export const env = parsed.data;

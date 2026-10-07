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
  // D1 partner contract (Alfred calls /api/v1/alfred). Unset = on outside production, off in it.
  PARTNER_CONTRACT_ENABLED: z.enum(["true", "false"]).optional(),
  ALFRED_PARTNER_AUDIENCE: z.string().min(1).default("partner-aerwell"),
  // Alfred's organisation id for Aerwell: the only `act.orgId` the partner surface accepts.
  ALFRED_PARTNER_ORG_ID: z.string().min(1).optional(),
  // Public Alfred host the outbox pushes events to (ALFRED_API_INTERNAL_URL is /internal only).
  ALFRED_API_URL: z.string().url().optional(),
  PARTNER_OUTBOX_ENABLED: z.enum(["true", "false"]).optional(),
  PARTNER_OUTBOX_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  PARTNER_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  PARTNER_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  PARTNER_OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),
  // Flat product shipping in cents (Q11). Unset = free shipping: a price is the client's to set.
  PRODUCT_SHIPPING_FLAT_CENTS: z.coerce.number().int().min(0).max(100_000).default(0),
  STAFF_JWT_SECRET: z.string().min(32).optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  SES_FROM_EMAIL: z.string().email().optional(),
  ADMIN_BASE_URL: z.string().url().optional(),
  // This API's own public origin, for links handed to others (catalog image URLs). Unset = no media.
  PUBLIC_API_URL: z.string().url().optional(),
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
// A blank `KEY=` line (as copied from .env.example) means "unset", not an empty value.
const withoutBlankValues = (input: unknown) =>
  input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== ""))
    : input;

const validatedEnv = envObject
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
  })
  // An enabled partner surface with no way to verify Alfred would answer 401 to everything.
  .refine(
    (value) =>
      value.PARTNER_CONTRACT_ENABLED !== "true" ||
      (value.ALFRED_PARTNER_ORG_ID && value.ALFRED_AUTH_JWKS_URL && value.AERWELL_ORG_ID),
    {
      path: ["PARTNER_CONTRACT_ENABLED"],
      message:
        "The partner contract needs ALFRED_PARTNER_ORG_ID, ALFRED_AUTH_JWKS_URL and AERWELL_ORG_ID",
    }
  );
export const envSchema = z.preprocess(withoutBlankValues, validatedEnv);

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Report names only: Zod messages can contain raw enum inputs or credentials.
  throw new Error(
    `Invalid environment keys: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`
  );
}
export const env = parsed.data;

import { z } from "zod";
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(72, "Use at most 72 characters")
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, "Password exceeds 72 bytes");
export const loginSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(72) })
  .strict();
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(200) }).strict();
export const otpSchema = z
  .object({ challengeId: z.string().regex(/^[a-f\d]{24}$/i), code: z.string().regex(/^\d{6}$/) })
  .strict();
export const forgotSchema = z.object({ email: emailSchema }).strict();
export const resetSchema = z
  .object({ token: z.string().min(1).max(200), password: passwordSchema })
  .strict();
export const changeSchema = z
  .object({ currentPassword: z.string().min(1).max(72), password: passwordSchema })
  .strict();

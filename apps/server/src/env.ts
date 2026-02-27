import { z } from "zod";

const envSchema = z.object({
  // Application configuration
  PRESIGNED_URL_EXPIRATION: z.string().optional().default("3600"),
  SECURE_SITE: z.union([z.literal("true"), z.literal("false")]).default("false"),
  DATABASE_URL: z.string().optional().default("file:/app/server/prisma/palmr.db"),
  CUSTOM_PATH: z.string().optional(),
  DEFAULT_LANGUAGE: z.string().optional(),
});

export const env = envSchema.parse(process.env);

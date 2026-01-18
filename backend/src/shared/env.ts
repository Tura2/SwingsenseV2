import { z } from 'zod';

export const Env = z.object({
  MARKET_PROVIDER: z.enum(['sample', 'yahoo', 'fmp']).default('sample'),
  MARKET_API_KEY: z.string().optional(),
  FUNDAMENTALS_PROVIDER_API_KEY: z.string().optional(),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  RETRY_MAX: z.coerce.number().int().min(0).max(10).default(3),
  // Optional throttling knobs (defaults kept in code if unset)
  HTTP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).optional(),
  HTTP_MIN_TIME_MS: z.coerce.number().int().min(0).max(60_000).optional(),
});
export type EnvVars = z.infer<typeof Env>;

export function readEnv(): EnvVars {
  return Env.parse(process.env);
}

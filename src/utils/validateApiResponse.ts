import { z } from 'zod';
import { logDeduplicator } from './logDeduplicator';

/**
 * Validate an external API response against a Zod schema.
 * Logs a warning if validation fails but returns the data as-is (graceful degradation).
 * This allows detection of API changes without breaking the app.
 */
export function validateApiResponse<T>(
  data: unknown,
  schema: z.ZodSchema<T>,
  apiName: string
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    void logDeduplicator.warn(`API response validation failed for ${apiName}`, {
      errors: result.error.issues.slice(0, 5).map(i => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    // Return data as-is — graceful degradation
    return data as T;
  }

  return result.data;
}

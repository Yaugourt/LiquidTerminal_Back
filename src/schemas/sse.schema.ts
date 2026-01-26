import { z } from 'zod';

/**
 * Schema for SSE stream endpoint query parameters
 */
export const sseStreamQuerySchema = z.object({
  query: z.object({
    coin: z.string().optional(),
    min_amount_dollars: z.coerce
      .number()
      .min(0, 'min_amount_dollars must be >= 0')
      .optional(),
    last_event_id: z.coerce
      .number()
      .int()
      .optional()
  }),
  params: z.object({})
});

export type SSEStreamQueryInput = z.infer<typeof sseStreamQuerySchema>;

import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalInt = z.coerce.number().int().min(0).optional();
const optionalOutcomeId = z.coerce.number().int().min(0).optional();

const paginationShape = {
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: optionalInt,
};

const dateRangeShape = {
  start: optionalString,
  end: optionalString,
};

/** GET /hip4/fills */
export const hip4FillsQuerySchema = z.object({
  query: z.object({
    user: optionalString,
    coin: optionalString,
    outcome_id: optionalOutcomeId,
    ...dateRangeShape,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/settlements */
export const hip4SettlementsQuerySchema = z.object({
  query: z.object({
    outcome_id: optionalOutcomeId,
    ...dateRangeShape,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/markets-enriched */
export const hip4MarketsEnrichedQuerySchema = z.object({
  query: z.object({
    class: optionalString,
    underlying: optionalString,
    question_id: optionalOutcomeId,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/questions-with-outcomes */
export const hip4QuestionsWithOutcomesQuerySchema = z.object({
  query: z.object({
    question_id: optionalOutcomeId,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/analytics */
export const hip4AnalyticsQuerySchema = z.object({
  query: z.object({
    interval: z.enum(['1h', '4h', '1d']).optional(),
    coin: optionalString,
    outcome_id: optionalOutcomeId,
    ...dateRangeShape,
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  }),
  params: z.object({}),
});

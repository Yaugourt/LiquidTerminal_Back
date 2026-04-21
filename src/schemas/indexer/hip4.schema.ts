import { z } from 'zod';

const optionalString = z.string().max(256).optional();
const optionalNum = z.coerce.number().optional();
const optionalInt = z.coerce.number().int().min(0).optional();
const optionalOutcomeId = z.coerce.number().int().min(0).optional();
const ethAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address');

const empty = {
  query: z.object({}),
  params: z.object({}),
};

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

/** GET /hip4/fees */
export const hip4FeesQuerySchema = z.object({
  query: z.object({
    user: optionalString,
    coin: optionalString,
    ...dateRangeShape,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/markets */
export const hip4MarketsQuerySchema = z.object({
  query: z.object({
    outcome_id: optionalOutcomeId,
    class: optionalString,
    underlying: optionalString,
    question_id: optionalOutcomeId,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/outcomes — alias of /hip4/markets */
export const hip4OutcomesQuerySchema = hip4MarketsQuerySchema;

/** GET /hip4/questions */
export const hip4QuestionsQuerySchema = z.object({
  query: z.object({
    question_id: optionalOutcomeId,
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

/** GET /hip4/outcome-tokens */
export const hip4OutcomeTokensQuerySchema = z.object({
  query: z.object({
    outcome_id: optionalOutcomeId,
    coin: optionalString,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/fee-scales */
export const hip4FeeScalesQuerySchema = z.object({
  query: z.object({
    ...dateRangeShape,
    ...paginationShape,
  }),
  params: z.object({}),
});

/** GET /hip4/user-actions */
export const hip4UserActionsQuerySchema = z.object({
  query: z.object({
    user: optionalString,
    action_type: z.enum(['Split', 'Merge', 'Negate', 'split', 'merge', 'negate']).optional(),
    outcome_id: optionalOutcomeId,
    ...dateRangeShape,
    ...paginationShape,
  }),
  params: z.object({}),
});

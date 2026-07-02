export class StakingError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'STAKING_ERROR') {
    super(message);
    this.name = 'StakingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ValidatorError extends StakingError {
  constructor(message: string = 'Failed to fetch validator data', statusCode: number = 500) {
    super(message, statusCode, 'VALIDATOR_ERROR');
  }
}

export class ValidatorNotFoundError extends ValidatorError {
  constructor(message: string = 'Validator not found') {
    super(message, 404);
  }
}

export class TrendingValidatorError extends StakingError {
  constructor(message: string = 'Failed to fetch trending validators', statusCode: number = 500) {
    super(message, statusCode, 'TRENDING_VALIDATOR_ERROR');
  }
}

export class ValidatorVotesError extends StakingError {
  constructor(message: string = 'Failed to fetch validator votes', statusCode: number = 500) {
    super(message, statusCode, 'VALIDATOR_VOTES_ERROR');
  }
}

export class RateLimitError extends StakingError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_ERROR');
  }
} 
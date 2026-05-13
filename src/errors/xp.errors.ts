export class XpError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'XP_ERROR') {
    super(message);
    this.name = 'XpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class XpUserNotFoundError extends XpError {
  constructor(message: string = 'XP user not found') {
    super(message, 404, 'XP_USER_NOT_FOUND');
    this.name = 'XpUserNotFoundError';
  }
}

/**
 * Thrown when an XP grant would exceed a daily cap and the atomic increment
 * was rolled back. Service-level guard, not exposed to the HTTP client (caller
 * catches it and silently returns 0 XP, consistent with previous behavior).
 */
export class XpDailyCapExceededError extends XpError {
  constructor(message: string = 'Daily XP cap reached for this action') {
    super(message, 429, 'XP_DAILY_CAP_EXCEEDED');
    this.name = 'XpDailyCapExceededError';
  }
}

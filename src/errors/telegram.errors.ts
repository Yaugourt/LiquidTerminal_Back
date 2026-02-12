export class TelegramError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'TELEGRAM_ERROR'
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export class TelegramUserNotFoundError extends TelegramError {
  constructor(message: string = 'Telegram user not found') {
    super(message, 404, 'TELEGRAM_USER_NOT_FOUND');
    this.name = 'TelegramUserNotFoundError';
  }
}

export class TelegramAccountNotLinkedError extends TelegramError {
  constructor(message: string = 'Telegram account is not linked to a LiquidTerminal account') {
    super(message, 404, 'TELEGRAM_ACCOUNT_NOT_LINKED');
    this.name = 'TelegramAccountNotLinkedError';
  }
}

export class TelegramAlreadyLinkedError extends TelegramError {
  constructor(message: string = 'This Telegram account is already linked to another user') {
    super(message, 409, 'TELEGRAM_ALREADY_LINKED');
    this.name = 'TelegramAlreadyLinkedError';
  }
}

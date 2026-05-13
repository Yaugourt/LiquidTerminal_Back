export class WalletError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'WALLET_ERROR'
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export class WalletNotFoundError extends WalletError {
  constructor(message: string = 'Wallet not found') {
    super(message, 404, 'WALLET_NOT_FOUND');
    this.name = 'WalletNotFoundError';
  }
}

export class WalletAlreadyExistsError extends WalletError {
  constructor(message: string = 'Wallet already exists') {
    super(message, 409, 'WALLET_ALREADY_EXISTS');
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletValidationError extends WalletError {
  constructor(message: string = 'Invalid wallet data') {
    super(message, 400, 'WALLET_VALIDATION_ERROR');
    this.name = 'WalletValidationError';
  }
}

export class UserNotFoundError extends WalletError {
  constructor(message: string = 'User not found') {
    super(message, 404, 'USER_NOT_FOUND');
    this.name = 'UserNotFoundError';
  }
}

export class WalletLimitExceededError extends WalletError {
  constructor(message: string = 'Maximum number of wallets reached (25 wallets per user)') {
    super(message, 400, 'WALLET_LIMIT_EXCEEDED');
    this.name = 'WalletLimitExceededError';
  }
}

export class WalletListNotFoundError extends WalletError {
  constructor(message: string = 'Wallet list not found') {
    super(message, 404, 'WALLET_LIST_NOT_FOUND');
    this.name = 'WalletListNotFoundError';
  }
}

export class WalletListAccessDeniedError extends WalletError {
  constructor(message: string = 'Access denied to this wallet list') {
    super(message, 403, 'WALLET_LIST_ACCESS_DENIED');
    this.name = 'WalletListAccessDeniedError';
  }
}

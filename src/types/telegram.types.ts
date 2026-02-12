/**
 * Response for linked account check (bot /start)
 */
export interface LinkedAccountResponse {
  linked: boolean;
  userId?: number;
  email?: string;
  name?: string;
  walletCount: number;
}

/**
 * Wallet info returned to the bot
 */
export interface LinkedWalletResponse {
  id: number;
  address: string;
  name: string | null;
  addedAt: Date;
}

/**
 * Wallet list summary returned to the bot
 */
export interface LinkedWalletListResponse {
  id: number;
  name: string;
  description: string | null;
  isPublic: boolean;
  itemsCount: number;
  createdAt: Date;
}

/**
 * Input for linking a Telegram account from the frontend
 */
export interface LinkTelegramInput {
  telegramUserId: string;
}

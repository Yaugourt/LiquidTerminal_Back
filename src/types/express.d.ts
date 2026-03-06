import { PrivyPayload } from './auth.types';
import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: PrivyPayload;
      currentUser?: {
        id: number;
        role: UserRole;
        privyUserId: string;
      };
      telegramBot?: {
        authenticated: boolean;
      };
    }
  }
}

export {};

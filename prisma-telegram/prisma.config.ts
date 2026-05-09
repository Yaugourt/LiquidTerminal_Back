import { defineConfig, env } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: './prisma-telegram/schema.prisma',
  datasource: {
    url: env<{ TELEGRAM_DATABASE_URL: string }>('TELEGRAM_DATABASE_URL'),
  },
  migrations: {
    path: './migrations',
  },
});

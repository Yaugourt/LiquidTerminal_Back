import { defineConfig, env } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: './prisma-historical/schema.prisma',
  datasource: {
    url: env<{ HISTORICAL_DATABASE_URL: string }>('HISTORICAL_DATABASE_URL'),
  },
  migrations: {
    path: './migrations',
  },
});

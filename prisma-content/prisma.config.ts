import { defineConfig, env } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: './prisma-content/schema.prisma',
  datasource: {
    url: env<{ CONTENT_DATABASE_URL: string }>('CONTENT_DATABASE_URL'),
  },
  migrations: {
    path: './migrations',
  },
});

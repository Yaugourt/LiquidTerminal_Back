import { defineConfig, env } from '@prisma/config';
import dotenv from 'dotenv';

// Charge les variables d'environnement depuis .env pour les commandes Prisma (migrate, generate, etc.)
dotenv.config();

export default defineConfig({
  // Emplacement de ton schema Prisma
  schema: './prisma/schema.prisma',

  // URL de connexion utilisée par les commandes Prisma (migrate, introspect, etc.)
  datasource: {
    url: env<{ DATABASE_URL: string }>('DATABASE_URL'),
  },

  // Optionnel mais explicite : dossier des migrations
  migrations: {
    path: './prisma/migrations',
  },
});



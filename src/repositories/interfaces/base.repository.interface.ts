/**
 * Interface de base pour les repositories.
 * Vide à dessein : un repository n'a plus de client Prisma interchangeable, la
 * transaction lui est liée par appel (voir `runWithTx` dans utils/tx-scope).
 */
export interface BaseRepository {}

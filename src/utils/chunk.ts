/**
 * Split an array into chunks of a given size.
 * Used for bulk database operations to avoid exceeding query limits.
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  if (size <= 0) throw new Error('Chunk size must be positive');
  if (array.length <= size) return [array];

  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

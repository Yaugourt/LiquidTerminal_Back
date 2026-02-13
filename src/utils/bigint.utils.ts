/**
 * Safely serialize BigInt values to Numbers for JSON responses.
 * Use this when returning Prisma records that contain BigInt fields.
 */
export function serializeBigInts<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? Number(value) : value
    )
  );
}

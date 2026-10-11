declare module 'lz4js' {
  /** Decompress an LZ4 frame. */
  export function decompress(src: Uint8Array, maxSize?: number): Uint8Array;
}

declare module 'yauzl-promise' {
  import type { Readable } from 'node:stream';

  export interface Entry {
    readonly filename: string;
    readonly uncompressedSize: number;
    readonly externalFileAttributes: number;
    openReadStream(): Promise<Readable>;
  }

  export interface Zip extends AsyncIterable<Entry> {
    close(): Promise<void>;
  }

  const yauzl: {
    fromBuffer(
      buffer: Buffer,
      options?: {
        decodeStrings?: boolean;
        validateEntrySizes?: boolean;
        validateFilenames?: boolean;
        strictFilenames?: boolean;
        supportMacArchive?: boolean;
      },
    ): Promise<Zip>;
  };
  export default yauzl;
}

declare module 'yauzl-promise' {
  const yauzl: {
    fromBuffer(buffer: Buffer, options?: Record<string, unknown>): Promise<any>;
  };
  export default yauzl;
}

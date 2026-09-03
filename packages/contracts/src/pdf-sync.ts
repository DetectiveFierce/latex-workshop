import { z } from 'zod';

export const sourcePositionSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});

export const sourceSelectionSchema = z
  .object({
    start: sourcePositionSchema,
    end: sourcePositionSchema,
    text: z.string().max(2_000).default(''),
    before: z.string().max(200).optional(),
    after: z.string().max(200).optional(),
  })
  .refine(
    ({ start, end }) =>
      end.line > start.line || (end.line === start.line && end.column >= start.column),
    { message: 'Selection end must not precede its start', path: ['end'] },
  );
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;

export const pdfPointSchema = z.object({
  page: z.number().int().positive(),
  x: z.number().finite().nonnegative().max(10_000_000),
  y: z.number().finite().nonnegative().max(10_000_000),
});

export const pdfRectSchema = pdfPointSchema.extend({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type PdfPoint = z.infer<typeof pdfPointSchema>;
export type PdfRect = z.infer<typeof pdfRectSchema>;

export const syncTexRecordSchema = z.object({
  page: z.number().int().positive(),
  x: z.number().finite(),
  y: z.number().finite(),
  h: z.number().finite().nullable(),
  v: z.number().finite().nullable(),
  W: z.number().finite().nullable(),
  H: z.number().finite().nullable(),
  D: z.number().finite().nullable(),
  input: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  before: z.string().nullable(),
  offset: z.number().int().nullable(),
  middle: z.string().nullable(),
  after: z.string().nullable(),
});
export type SyncTexRecord = z.infer<typeof syncTexRecordSchema>;

export const forwardSyncRequestSchema = z.object({
  path: z.string().min(1).max(1_024),
  selection: sourceSelectionSchema,
  entryVersion: z.number().int().nonnegative(),
  pageHint: z.number().int().positive().optional(),
});
export type ForwardSyncRequest = z.infer<typeof forwardSyncRequestSchema>;

export const pdfSyncResultSchema = z.object({
  point: pdfPointSchema,
  rect: pdfRectSchema,
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  matchKind: z.enum(['text', 'container', 'point']),
  confidence: z.enum(['exact', 'context', 'approximate']),
  artifactStale: z.boolean(),
  sourceFileChangedSinceCompile: z.boolean(),
  selectedText: z.string().nullable(),
});
export type PdfSyncResult = z.infer<typeof pdfSyncResultSchema>;

export const inverseSyncRequestSchema = pdfPointSchema;
export type InverseSyncRequest = z.infer<typeof inverseSyncRequestSchema>;

export const inverseSyncResultSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nullable(),
});
export type InverseSyncResult = z.infer<typeof inverseSyncResultSchema>;

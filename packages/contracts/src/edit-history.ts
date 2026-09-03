import { z } from 'zod';
const idSchema = z.uuid();

export const editorSelectionRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});
export const editorSelectionSnapshotSchema = z.array(editorSelectionRangeSchema).min(1).max(100);
export type EditorSelectionSnapshot = z.infer<typeof editorSelectionSnapshotSchema>;

export const editHistoryNodeSchema = z.object({
  id: idSchema,
  entryId: idSchema,
  parentId: idSchema.nullable(),
  preferredChildId: idSchema.nullable(),
  beforeHash: z.string(),
  afterHash: z.string(),
  summary: z.string(),
  selectionBefore: editorSelectionSnapshotSchema.nullable(),
  selectionAfter: editorSelectionSnapshotSchema.nullable(),
  createdAt: z.iso.datetime(),
  current: z.boolean().default(false),
});
export type EditHistoryNode = z.infer<typeof editHistoryNodeSchema>;

export const editHistoryResponseSchema = z.object({
  nodes: z.array(editHistoryNodeSchema),
  currentNodeId: idSchema,
  content: z.string(),
  version: z.number().int().nonnegative(),
  nextCursor: idSchema.nullable(),
});
export type EditHistoryResponse = z.infer<typeof editHistoryResponseSchema>;

export const editHistoryCommitSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  expectedHeadId: idSchema.nullable(),
  clientMutationId: z.string().uuid(),
  content: z.string(),
  summary: z.string().trim().min(1).max(160),
  selectionBefore: editorSelectionSnapshotSchema.nullable().default(null),
  selectionAfter: editorSelectionSnapshotSchema.nullable().default(null),
});

export const editHistoryCheckoutSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  expectedHeadId: idSchema,
  targetNodeId: idSchema,
});

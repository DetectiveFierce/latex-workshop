export type WorkspaceTitleMode = 'editor' | 'pdf' | 'combined';

export function projectDocumentTitle(projectName: string, mode: WorkspaceTitleMode) {
  const prefix = mode === 'combined' ? '' : `${mode === 'editor' ? 'Editor' : 'PDF'} - `;
  return `${prefix}${projectName} - Latex Workshop`;
}

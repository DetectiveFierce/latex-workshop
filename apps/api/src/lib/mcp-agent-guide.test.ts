import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  editLatexWorkshopProjectPrompt,
  mindPalaceEditingGuide,
  mindPalaceMcpInstructions,
  mindPalaceMcpServerName,
  mindPalaceMcpServerVersion,
  projectScopeRule,
} from './mcp-agent-guide.js';

describe('Mind Palace MCP agent guidance', () => {
  it('makes live editing and refresh the default while preserving optional review', () => {
    expect(mindPalaceMcpServerName).toBe('Mind Palace LaTeX Workshop');
    expect(mindPalaceMcpServerVersion).toBe('0.6.0');
    expect(mindPalaceMcpInstructions).toContain('no owner review is required');
    expect(mindPalaceMcpInstructions).toContain('reread affected live files');
    expect(mindPalaceMcpInstructions).toContain('same paper');
    expect(mindPalaceMcpInstructions).toContain('get_editing_guide');
    expect(mindPalaceMcpInstructions.length).toBeLessThan(4_000);
    for (const instruction of [
      'edit_project',
      'compile_project',
      'undoCheckpointId',
      'create-only',
      'identical retry',
      'explicit review-first request',
      'BU Semester',
    ])
      expect(mindPalaceMcpInstructions).toContain(instruction);
    expect(projectScopeRule).toContain('MUST call create_project');
    expect(projectScopeRule).toContain('MUST call rename_project');
    expect(mindPalaceEditingGuide).toContain(
      'Whole-project restoration also replaces later saved changes',
    );
    expect(mindPalaceEditingGuide).toContain('unsaved browser typing');
    expect(mindPalaceEditingGuide).toContain('Only the owner can apply a proposal');
  });

  it('generates a live-edit prompt without a mandatory owner handoff', () => {
    const prompt = editLatexWorkshopProjectPrompt('Research Notes', 'Add the missing citation.');
    expect(prompt).toContain('project named "Research Notes"');
    expect(prompt).toContain('Add the missing citation.');
    expect(prompt).toContain('edit_project');
    expect(prompt).toContain('compile_project');
    expect(prompt).not.toContain('finish the proposal for owner review');
  });

  it('keeps the distributed plugin aligned with live editing on subsequent turns', () => {
    const skill = readFileSync(
      new URL(
        '../../../../plugins/latex-workshop/skills/latex-workshop-projects/SKILL.md',
        import.meta.url,
      ),
      'utf8',
    );
    for (const term of [
      'subsequent turns',
      'read_text_file',
      'edit_project',
      'expectedSourceRevision',
      'compile_project',
      'Undo history',
      'reviewOnly=true',
      'manageAccessUrl',
    ])
      expect(skill).toContain(term);
    expect(skill).not.toContain('Make all file changes inside that isolated proposal');
  });
});

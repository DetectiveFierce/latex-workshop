import { describe, expect, it } from 'vitest';
import {
  editLatexWorkshopProjectPrompt,
  mindPalaceEditingGuide,
  mindPalaceEditingGuideUri,
  mindPalaceMcpInstructions,
  mindPalaceMcpServerName,
  projectScopeRule,
} from './mcp-agent-guide.js';

describe('Mind Palace MCP agent guidance', () => {
  it('identifies the site and defines the complete proposal lifecycle', () => {
    expect(mindPalaceMcpServerName).toBe('Mind Palace LaTeX Workshop');
    expect(mindPalaceMcpInstructions).toContain('Mind Palace site');
    expect(mindPalaceMcpInstructions).toContain('not the VS Code extension');
    expect(mindPalaceMcpInstructions).toContain('create_project');
    expect(mindPalaceMcpInstructions).toContain('rename_project');
    expect(projectScopeRule).toContain('top-level Library item');
    expect(projectScopeRule).toContain('MUST call create_project');
    expect(projectScopeRule).toContain('Do not use start_proposal');
    expect(projectScopeRule).toContain('MUST call rename_project');
    expect(mindPalaceMcpInstructions).toContain(mindPalaceEditingGuideUri);
    expect(mindPalaceMcpInstructions.length).toBeLessThan(2_000);
    expect(mindPalaceEditingGuide).toContain('every byte of seeded source');
    expect(mindPalaceEditingGuide).toContain('Source remains unaccepted');

    const steps = [
      'list_projects',
      'get_project_tree',
      'read_text_file',
      'start_proposal',
      'put_proposal_file',
      'finish_proposal',
    ];
    for (const step of steps) {
      const index = mindPalaceEditingGuide.indexOf(step);
      expect(index, `${step} should be documented`).toBeGreaterThan(-1);
    }
    expect(mindPalaceEditingGuide).toContain('complete desired file content');
    expect(mindPalaceEditingGuide).toContain('expectedProposalRevision');
    expect(mindPalaceEditingGuide).toContain('needs_rebase');
    expect(mindPalaceEditingGuide).toContain('Only the owner can apply a proposal');
    expect(mindPalaceEditingGuide).toContain('Create a project from a template');
    expect(mindPalaceEditingGuide).toContain('Create a reusable template');
    expect(mindPalaceEditingGuide).toContain('Do not translate “create a template”');
    expect(mindPalaceEditingGuide).toContain(
      'make further file changes in the proposal returned by `create_project`',
    );
    expect(mindPalaceEditingGuide).toContain('automatically returned compile');
    expect(mindPalaceEditingGuide).toContain('get_compile_page_images');
    expect(mindPalaceEditingGuide).toContain('do not routinely poll');
  });

  it('builds an immediately actionable edit prompt', () => {
    const prompt = editLatexWorkshopProjectPrompt(
      'Research Notes',
      'Add the missing citation to the introduction.',
    );
    expect(prompt).toContain('Mind Palace LaTeX Workshop project named "Research Notes"');
    expect(prompt).toContain('Add the missing citation to the introduction.');
    expect(prompt).toContain('finish the proposal for owner review');
  });
});

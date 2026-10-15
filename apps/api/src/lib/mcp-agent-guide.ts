export const mindPalaceMcpServerName = 'Mind Palace LaTeX Workshop';
export const mindPalaceMcpServerVersion = '0.6.0';
export const mindPalaceEditingGuideUri = 'mind-palace://latex-workshop/agent-editing-guide';
export const projectScopeRule =
  'TOP-LEVEL SCOPE RULE: A project or template is a top-level Library item, never a .tex file or folder inside another project. If the user asks to create, make, or add a new project/template, you MUST call create_project. Do not use start_proposal, put_proposal_file, or propose_structure on the source project to create it. If the user asks to rename a project/template, you MUST call rename_project; structure operations only rename entries inside a project.';

export const mindPalaceMcpInstructions = `
This interface accesses LaTeX Workshop projects on the user's Mind Palace site—not local folders and not the VS Code extension. Activate on LaTeX Workshop mentions or requests to edit/query a LaTeX file, including indirect follow-ups about an established file. No explicit skill invocation is required. Generic "check my proof" or math help alone does not activate Workshop. Read-only queries do not authorize unrelated edits. Honor explicit local-file or other-product choices. Call list_projects first; never guess ids. Do not claim filesystem access is required. The connection remains available throughout the conversation. Follow-ups like "the same paper" retain project context. Call list_projects again and refresh current site state.

Default workflow: get_project_tree → read_text_file → edit_project → compile_project → get_compile_page_images. Source edits are immediate and undoable; no owner review is required. edit_project takes complete files, their current baseHash (null for create-only), expectedSourceRevision from the fresh tree, a short title, and a fresh UUID idempotencyKey. It atomically applies files and structure and returns new hashes plus undoCheckpointId. For each subsequent edit reread affected live files, including owner changes; never reuse stale hashes. On conflict refresh and submit a new operation. Reuse a UUID only for an identical retry.

The owner can undo file edits in Undo history or restore the pre-edit checkpoint in Version history. Proposal tools are optional: use them only for an explicit review-first request, then return reviewUrl. create_project seeds live source by default; reviewOnly=true requests review instead. Create in a folder with folderId, move with organize_library action move_project; folderId=null means Library root. Follow established folder/tag conventions.

${projectScopeRule}

For requests combining BU Semester courses and Workshop projects, call the separate BU Semester app for course evidence and this app for project files in the same response. Do not substitute one collection for the other. Missing projects: return manageAccessUrl. See ${mindPalaceEditingGuideUri} or get_editing_guide for full capabilities and examples.
`.trim();

export const mindPalaceEditingGuide = `# Editing Mind Palace LaTeX Workshop

Projects are hosted on the user's Mind Palace site. This connection persists across messages. Activate on a mention of LaTeX Workshop or a request to edit or query a LaTeX file, including follow-ups about an established file. No explicit skill invocation is required. Generic proof checking or math help alone does not activate Workshop. Use the conversation to resolve the requested file, and read accessible metadata when needed. Keep writes within the user's requested work and honor explicit local-file or other-product choices. Read and write hosted files through these tools.

## Scope and capabilities

${projectScopeRule}

- list_projects: accessible projects/templates, Library folders, tags, placement, capabilities, manageAccessUrl.
- get_project_tree: current saved paths, sourceRevision, file hashes/versions and editable flags.
- read_text_file: current UTF-8 source, including owner edits and prior agent edits. Follow nextOffset until null. Restart a paginated read if its hash changes.
- edit_project: immediate atomic batch of full file contents and folder creation, moves, renames, deletions. No owner approval step. baseHash is required on every file: use its current read hash for replacement, null for create-only. expectedSourceRevision comes from the fresh tree. Conflicts change no accepted files.
- compile_project: compile live saved source and return diagnostics/log. Failed builds preserve the last successful PDF. get_project_compile recovers a pending or interrupted wait by exact job id.
- get_compile_page_images: inspect up to three pages of an exact successful compile. Use projectId for live project builds or proposalId for optional review builds.
- create_project: new top-level project; omit sourceProjectId for blank source, or pass a granted template/project to copy. isTemplate=true creates a reusable template copied by value. Seeded source is live by default. Customize the NEW project with edit_project, never sourceProjectId. reviewOnly=true is only for explicit review-first requests.
- rename_project: immediate top-level project/template rename.
- organize_library: immediate folders, tags, project placement and tag assignments. action="move_project" with folderId=null moves to Library root. Refresh list_projects after organization changes. Honor explicit placement or established folder/tag conventions. Deleting a tag removes assignments; trashing a Library folder trashes its subtree and contained projects. Ungranted projects remain protected.
- Optional review: start_proposal, put_proposal_file, propose_structure, get_proposal, compile_proposal, get_proposal_compile, finish_proposal. These keep source isolated until the owner accepts it.

## Repeated live editing

1. Resolve the displayed project name with list_projects. If absent, provide manageAccessUrl; if ambiguous, ask which project.
2. Read get_project_tree, then relevant read_text_file pages. Keep the current sourceRevision and every complete file's hash.
3. Call edit_project with a short title, a fresh UUID, files=[{path, content, baseHash}], and optional structure operations. content is the complete desired file content. Folder creation must list parents before children. Keep a file write and a move/delete of that file or an ancestor in separate edits. Binary assets are listed but source editing supports only valid UTF-8 text and source-only folder subtrees. Limits: 2,000,000 UTF-8 bytes per file, 10,000,000 text bytes per batch, and 100 changed entries; read pages can request up to 256 KiB.
4. Changes are live when applied=true. The response includes the current tree and undoCheckpointId. Call compile_project with the latest sourceRevision for output-affecting work; inspect warnings even when succeeded. If still running, call get_project_compile with its job id. Inspect PDF pages for layout-sensitive edits.
5. Correct failures by rereading current files and making another edit_project call. On a follow-up such as "now update it" or "that project", resolve again and reread affected files. Owner changes are part of the current saved state; unsaved browser typing is not yet available to the agent.

Example: read main.tex with hash H at sourceRevision R, then edit_project({projectId, expectedSourceRevision:R, title:"Revise introduction", idempotencyKey:NEW_UUID, files:[{path:"main.tex", baseHash:H, content:COMPLETE_TEXT}]}). Next time, read the current main.tex again and use its NEW hash and the latest tree revision.

## Undo and retries

Each applied edit saves a pre-edit project checkpoint and adds labeled file Undo history. The owner can use Undo history for one file, or Version history → Before agent edit → Restore checkpoint for the complete file/folder state. Restoration creates new state; it does not erase history. Whole-project restoration also replaces later saved changes, so use file history when later work should be retained. Checkpoints are retained for 30 days.

An identical transport retry uses the SAME idempotencyKey and does not apply twice, even after the owner undoes it. A different edit uses a NEW UUID. A stale revision/hash conflict requires rereading the current tree and files, reconstructing the intended change against them, and submitting a fresh key. Never bypass a conflict with null: null only creates a missing file.

## Optional proposal review

Only use this workflow when the user explicitly asks for review before applying. start_proposal returns a durable review draft. put_proposal_file uses complete desired file content and baseHash; propose_structure changes only project entries. Chain expectedProposalRevision from each response and generate a fresh mutation UUID. finish_proposal automatically compiles its frozen revision; inspect diagnostics, correct failures, and finish again. get_proposal_compile recovers interrupted waits; do not routinely poll completed jobs. needs_rebase means reread conflicts and rewrite using current hashes. A reviewing proposal is ready for the owner, not live: Only the owner can apply a proposal using its reviewUrl.
`;

export function editLatexWorkshopProjectPrompt(project: string, change: string) {
  return `Edit the Mind Palace LaTeX Workshop project named "${project}" to make this change:\n\n${change}\n\nUse the connected Mind Palace LaTeX Workshop tools. Resolve with list_projects, inspect get_project_tree and current read_text_file contents, then apply complete changes with edit_project. Compile with compile_project, inspect diagnostics, and correct errors. Refresh current files for each subsequent edit. Undo is available in Mind Palace. Use optional proposals only if explicitly asked to review first. Do not modify local files as a substitute and do not claim filesystem access is required.`;
}

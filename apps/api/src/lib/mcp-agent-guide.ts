export const mindPalaceMcpServerName = 'Mind Palace LaTeX Workshop';
export const mindPalaceMcpServerVersion = '0.5.1';
export const mindPalaceEditingGuideUri = 'mind-palace://latex-workshop/agent-editing-guide';

export const projectScopeRule =
  'TOP-LEVEL SCOPE RULE: A project or template is a top-level Library item, never a .tex file or folder inside another project. If the user asks to create, make, or add a new project/template, you MUST call create_project. Do not use start_proposal, put_proposal_file, or propose_structure on the source project to create it. If the user asks to rename a project/template, you MUST call rename_project; propose_structure only renames entries inside a project.';

export const mindPalaceMcpInstructions = `
This interface accesses LaTeX Workshop projects on the user's Mind Palace site—not local folders and not the VS Code extension. For any related request, call list_projects first. Do not claim filesystem access is required.

This connection remains available throughout the conversation. Treat follow-ups such as "also compile it", "that project", "the same paper", or "try again" as related when earlier context identified Mind Palace, even if the product name is omitted. Call list_projects again and continue with these tools; shorthand does not make the connection unavailable.

${projectScopeRule}

list_projects returns Library folders, tags, project folderId/tagIds, organizationComplete, and manageAccessUrl. Never guess ids. Create directly in a folder with create_project folderId. Move an existing project with organize_library action move_project, its projectId, and the destination folderId; folderId=null means Library root. These are top-level Library operations, not proposal structure edits. Refresh list_projects after changes. Read ${mindPalaceEditingGuideUri} before multi-step writes or when handling pagination, conflicts, compile failure, or owner handoff.

For a new project, honor explicit placement or infer folder/tag conventions from similar projects; avoid speculative tags. Creation, renaming, and Library organization are immediate metadata operations. Source-tree changes use isolated proposals. finish_proposal compiles one revision for owner review. Return reviewUrl; only the owner can apply changes.
`.trim();

export const mindPalaceEditingGuide = `# Editing a Mind Palace LaTeX Workshop project

## Meaning

"LaTeX Workshop project" means a project hosted in the user's private LaTeX Workshop on the Mind Palace site. It does not mean a repository directory or the similarly named VS Code extension.

## Mandatory scope decision

${projectScopeRule}

| User intent | Correct tool scope | Required first write |
| --- | --- | --- |
| Create/add/make a new project | New top-level Library item | \`create_project\` with \`isTemplate=false\` |
| Create/add/make a new template | New top-level Templates item | \`create_project\` with \`isTemplate=true\` |
| Rename a project or template | Top-level metadata | \`rename_project\` |
| Add/replace/rename a file or folder | Inside one existing project | \`start_proposal\`, then proposal tools |
| Organize projects, Library folders, or tags | Top-level metadata | \`organize_library\` |

Do not translate “create a template” into “create a .tex file.” Do not translate “rename a project” into an entry move. A source project used for formatting is read-only reference material unless the user separately asks to edit that source project.

## Fast, safe workflow

- **Templates** — a template is a normal editable project with \`isTemplate=true\`. It appears in the Templates library and is copied by value: later template edits do not alter projects already created from it.
- **Create a blank project** — call \`create_project\` without \`sourceProjectId\` and with \`isTemplate=false\`.
- **Create a project from a template** — resolve the template with \`list_projects\`, pass its id as \`sourceProjectId\`, and keep \`isTemplate=false\`.
- **Place and tag a project** — inspect the folders, tags, and assignments returned by \`list_projects\`. Pass suitable existing \`folderId\` and \`tagIds\` to \`create_project\`. Honor explicit placement first; otherwise use the source/template or closely related projects as evidence. Prefer root/no tags when evidence is weak instead of inventing categories.
- **Move an existing project** — call \`organize_library\` with \`action="move_project"\`, the granted \`projectId\`, and the destination Library \`folderId\`. Use \`folderId=null\` to move it to Library root. Then call \`list_projects\` again and verify the project's returned \`folderId\`. This changes placement metadata immediately and does not create a proposal.
- **Create missing organization** — use \`organize_library\` first only when the user asked for that organization or the existing Library shows a clear convention, then call \`list_projects\` again and use the returned ids.
- **Create a reusable template** — call \`create_project\` with \`isTemplate=true\`. To base it on the current project’s formatting, pass that project id as \`sourceProjectId\`; omit the source for the standard blank document.
- **Customize a newly created item** — make further file changes in the proposal returned by \`create_project\`. That proposal’s \`projectId\` is the new item. Never start a proposal on \`sourceProjectId\` merely because its formatting was used as the reference.
- **Creation review boundary** — project/template metadata exists immediately without confirmation, while every byte of seeded source is frozen in the returned \`reviewing\` proposal. The tool automatically waits for its compile and returns warnings/errors in \`compile\`. Source remains unaccepted until the owner accepts the hunks.
- **Rename** — call \`rename_project\` without asking for confirmation. This changes only project metadata and does not use a proposal.
- **Library organization** — \`organize_library\` immediately creates, renames, moves, or trashes Library folders; creates, renames, or deletes tags; moves projects between folders or to root; and replaces a project's complete tag set. These are top-level document operations, unlike source-tree changes made with \`propose_structure\`. Moving a project requires \`action="move_project"\`; never model it as moving a \`.tex\` file or source folder. Explain before trashing a folder that its subtree and contained projects go to Trash, and before deleting a tag that its assignments are removed. The tool refuses destructive changes that touch ungranted projects.

1. **Resolve** — call \`list_projects\`, choose the granted project by its displayed name, and retain its id. Never guess an id. If the project is absent, give the user the returned \`manageAccessUrl\` so they can grant it under **Account settings → Agent access**.
2. **Inspect** — call \`get_project_tree\`; read the relevant editable files with \`read_text_file\`. Continue paged reads while \`nextOffset\` is not null. Keep the returned hash for every existing file you may change.
3. **Draft** — call \`start_proposal\`. It returns the existing active proposal for this client when one already exists, so inspect its title, status, revision, and changes before continuing.
4. **Implement** — call \`put_proposal_file\` with the complete desired file content. Include \`baseHash\` when replacing an accepted file. Use \`propose_structure\` for source-only folders, moves, renames, and deletions. Chain every write from the latest returned \`revision\`, and generate a new UUID \`idempotencyKey\` for each distinct operation.
5. **Submit and verify** — call \`finish_proposal\` with the latest revision. It freezes the review, automatically compiles that exact review revision, waits for the result, and returns the complete compile job in \`compile\`. Inspect all diagnostics even when status is \`succeeded\`, because successful LaTeX builds may contain warnings. For visual or layout-sensitive work, call \`get_compile_page_images\` with the proposal id, exact succeeded compile job id, and up to three one-based page numbers per request; inspect additional pages in further calls. If compilation fails or a rendered page exposes a defect, revise the proposal and finish again. \`reviewing\` means the owner can inspect and accept/reject hunks; it does not mean source was accepted.
6. **Recovery and optional preflight** — \`compile_proposal\` explicitly compiles a draft and waits for the job in the same response. \`get_proposal_compile\` is only a recovery path after an interrupted or unusually long request; do not routinely poll it.

## Revision and conflict rules

- \`expectedProposalRevision\` is compare-and-swap protection. Always take it from the immediately preceding proposal response.
- Reuse an idempotency key only when retrying the exact same operation after an uncertain transport result.
- \`needs_rebase\` means accepted source changed after the draft was based. Reread each path in \`conflicts\`, reconstruct the desired complete file with its current hash, write it again, recompile, and finish again.
- A write to a proposal already in \`reviewing\` reopens it as \`draft\`; finish the revised version again and inspect its automatically returned compile.
- Only the owner can apply a proposal. Link the \`reviewUrl\` returned by \`finish_proposal\` and tell the user to use the Mind Palace proposal review controls to accept the desired hunks.
`;

export function editLatexWorkshopProjectPrompt(project: string, change: string) {
  return `Edit the Mind Palace LaTeX Workshop project named "${project}" to make this change:\n\n${change}\n\nUse only the connected Mind Palace LaTeX Workshop tools for the project. Resolve it with list_projects, inspect its tree and relevant source, implement the complete change in an isolated proposal, compile and correct it when output may be affected, then finish the proposal for owner review and give the user its reviewUrl. Do not modify local files as a substitute, do not claim filesystem access is required, and do not claim the change is accepted before the owner accepts it on the site.`;
}

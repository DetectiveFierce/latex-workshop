---
name: latex-workshop-projects
description: Activate on mentions of LaTeX Workshop or requests to edit or query a LaTeX file, including follow-ups about an established file. No explicit skill invocation is needed. Generic proof checking or math help alone does not activate this skill. Uses connected Mind Palace project tools; honor explicit local-file and VS Code extension requests.
---

# Mind Palace LaTeX Workshop projects

Treat “LaTeX Workshop project” as a project hosted on the user's Mind Palace site. Never substitute a local directory, ask for a file upload, or say filesystem access is required when the connected LaTeX Workshop tools are available.

Select this skill implicitly on a mention of LaTeX Workshop or a request to edit or query a LaTeX file. This includes indirect follow-ups about a file established earlier in the conversation, such as “apply that correction to it.” No explicit skill invocation or renewed permission to use an existing connection is required. A generic request such as “check my proof,” “explain this theorem,” or “help with homework” does not activate the skill by itself; do not search Workshop merely because it might contain relevant math. Read accessible project metadata to resolve the requested document when needed. Edit only within the user's requested work; read-only queries do not authorize unrelated source changes. When an explicit local path or VS Code extension request triggers this skill, honor that choice and route to the appropriate local tools rather than the hosted Workshop.

Keep this workflow active across subsequent turns in the same conversation. When the preceding context established a Mind Palace project, interpret follow-ups such as “now revise the conclusion”, “also compile it”, “that project”, “the same paper”, or “try again” as requests to use the connected LaTeX Workshop tools again. Do not require the user to repeat the product or project name. Start the follow-up with `list_projects`, resolve the prior displayed name against the fresh result, and continue from current site state rather than relying on stale ids or hashes.

Start every task with `list_projects`, even when a project was named in the prompt. Match the displayed project name; never invent an id. If it is missing, give the user the returned `manageAccessUrl`. If multiple projects plausibly match, ask which one they mean.

`list_projects` also returns the accessible Library folder tree, tag catalog, each granted project's `folderId` and `tagIds`, and whether `organizationComplete` is true. Use that organization when resolving projects and before creating or organizing one. `organize_library` performs immediate metadata actions: create, rename, or move folders; move a folder subtree to Trash; create, rename, or delete tags; move a project; or replace a project's complete tag set. Use only ids returned by `list_projects` or an immediately preceding create result, and refresh `list_projects` after an organization change. With project-scoped access, empty or unrelated folders and tags may remain hidden.

Project placement is a first-class Library capability:

- Create a project inside an existing Library folder by passing that folder's id as `folderId` to `create_project`. Omit `folderId` to create it at Library root.
- Move an existing project by calling `organize_library` with `action="move_project"`, the granted `projectId`, and the destination `folderId`. Pass `folderId=null` to move it to Library root.
- After either operation, call `list_projects` again and verify the project's returned `folderId`.
- A Library folder contains whole projects. Do not use `propose_structure` or move a `.tex` file when the user asks to place or move a project.

For an existing project:

1. Call `get_project_tree`, then read relevant text files with `read_text_file`. Follow `nextOffset` until null; restart if the hash changes between pages. Retain each current hash and the tree's `sourceRevision`.
2. Call `edit_project` with complete resulting file contents, current hashes as `baseHash` (null means create-only), `expectedSourceRevision`, a short undo-history title, and a fresh UUID `idempotencyKey`. Use `structure` for folders, moves, renames, and deletions. Changes apply atomically and immediately, with no owner approval step. Write a file and move/delete that path in separate calls.
3. Call `compile_project` and inspect returned diagnostics and warnings. Correct failures by rereading current files and editing again. Use `get_compile_page_images` with `projectId` and the successful job id for visual inspection. Use `get_project_compile` only when the compile wait is interrupted or still pending.
4. Refresh relevant live files before each subsequent edit, including follow-ups across multiple messages. Current saved owner changes are visible; unsaved browser typing is not. On conflicts, reread, reconstruct against current content, and submit a fresh UUID. An identical transport retry reuses its original UUID and never applies twice.
5. Report that changes are live and link the workspace. The owner can undo one file in Undo history or restore the labeled pre-edit checkpoint in Version history. Whole-project restore also replaces later saved changes. Checkpoints are retained for 30 days.

Use `start_proposal` and `finish_proposal` only when the user explicitly requests review before applying. Follow the server's `get_editing_guide` for that optional workflow and give the owner its `reviewUrl`; `reviewing` is not accepted.

Top-level projects and templates are Library items, not files. Use `create_project` for a new project or template and `rename_project` for a top-level rename. When creating from a source project or template, customize only the newly created project with `edit_project`; seeded source is live by default. Set `reviewOnly=true` only for explicit review requests.

For a new normal project, choose `folderId` and `tagIds` from the current Library and pass them in the initial `create_project` call. Honor explicit placement first; otherwise infer from the source/template, closely related project names, and established folder/tag usage. Prefer existing relevant folders and tags, avoid speculative or excessive tags, and leave the project at root or untagged when evidence is weak. Create a new folder or tag first only when the user's requested organization or a clear existing convention makes it appropriate. Templates stay in the Templates library unless the user explicitly asks for metadata the product supports.

Library folder operations refer to top-level document projects, while `propose_structure` handles files and folders inside a project. Trashing a Library folder also trashes its subtree and contained granted projects; deleting a tag removes that tag assignment. State that consequence before invoking either destructive action. If the tool reports that ungranted projects would be affected, provide `manageAccessUrl` rather than working around the grant boundary.

For optional proposals, `needs_rebase` means reread conflicts, rewrite against current hashes, and finish again. Never route a normal live edit through owner proposal approval.

If the connected tools are unavailable, tell the user to install or enable the workspace LaTeX Workshop plugin in ChatGPT and authorize projects under **Mind Palace → Account settings → Agent access**. Describe this as a missing app connection, not a filesystem limitation.

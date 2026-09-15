---
name: latex-workshop-projects
description: Use when a user asks to find, organize, read, create, rename, edit, fix, compile, tag, move, or review a LaTeX Workshop or Mind Palace LaTeX project. Also use on subsequent turns when the user refers indirectly to a Mind Palace project established earlier in the conversation, such as "it", "that project", "the same paper", "now", "also", or "try again". Operates the private site through connected tools, not local files or the VS Code extension.
---

# Mind Palace LaTeX Workshop projects

Treat “LaTeX Workshop project” as a project hosted on the user's Mind Palace site. Never substitute a local directory, ask for a file upload, or say filesystem access is required when the connected LaTeX Workshop tools are available.

Keep this workflow active across subsequent turns in the same conversation. When the preceding context established a Mind Palace project, interpret follow-ups such as “now revise the conclusion”, “also compile it”, “that project”, “the same paper”, or “try again” as requests to use the connected LaTeX Workshop tools again. Do not require the user to repeat the product or project name. Start the follow-up with `list_projects`, resolve the prior displayed name against the fresh result, and continue from current site state rather than relying on stale ids or hashes.

Start every task with `list_projects`, even when a project was named in the prompt. Match the displayed project name; never invent an id. If it is missing, give the user the returned `manageAccessUrl`. If multiple projects plausibly match, ask which one they mean.

`list_projects` also returns the accessible Library folder tree, tag catalog, each granted project's `folderId` and `tagIds`, and whether `organizationComplete` is true. Use that organization when resolving projects and before creating or organizing one. `organize_library` performs immediate metadata actions: create, rename, or move folders; move a folder subtree to Trash; create, rename, or delete tags; move a project; or replace a project's complete tag set. Use only ids returned by `list_projects` or an immediately preceding create result, and refresh `list_projects` after an organization change. With project-scoped access, empty or unrelated folders and tags may remain hidden.

Project placement is a first-class Library capability:

- Create a project inside an existing Library folder by passing that folder's id as `folderId` to `create_project`. Omit `folderId` to create it at Library root.
- Move an existing project by calling `organize_library` with `action="move_project"`, the granted `projectId`, and the destination `folderId`. Pass `folderId=null` to move it to Library root.
- After either operation, call `list_projects` again and verify the project's returned `folderId`.
- A Library folder contains whole projects. Do not use `propose_structure` or move a `.tex` file when the user asks to place or move a project.

For an existing project:

1. Call `get_project_tree`, then read every relevant text file with `read_text_file`. Follow `nextOffset` until it is null and retain each file hash.
2. Call `start_proposal`. Make all file changes inside that isolated proposal using complete file contents, accepted hashes as `baseHash`, the latest `expectedProposalRevision`, and a fresh UUID for each distinct mutation.
3. Use `propose_structure` for file or folder moves, renames, and deletions. Proposal tools never change accepted source.
4. Call `finish_proposal`; inspect the returned compile diagnostics and warnings. Correct failures or visible layout defects by revising and finishing again. Use `get_compile_page_images` for visual or layout-sensitive work.
5. When the proposal is `reviewing`, tell the user it is ready—not accepted—and link the returned `reviewUrl`. Only the owner can accept changes in Mind Palace.

Top-level projects and templates are Library items, not files. Use `create_project` for a new project or template and `rename_project` for a top-level rename. When creating from a source project or template, customize only the proposal returned for the new project.

For a new normal project, choose `folderId` and `tagIds` from the current Library and pass them in the initial `create_project` call. Honor explicit placement first; otherwise infer from the source/template, closely related project names, and established folder/tag usage. Prefer existing relevant folders and tags, avoid speculative or excessive tags, and leave the project at root or untagged when evidence is weak. Create a new folder or tag first only when the user's requested organization or a clear existing convention makes it appropriate. Templates stay in the Templates library unless the user explicitly asks for metadata the product supports.

Library folder operations refer to top-level document projects, while `propose_structure` handles files and folders inside a project. Trashing a Library folder also trashes its subtree and contained granted projects; deleting a tag removes that tag assignment. State that consequence before invoking either destructive action. If the tool reports that ungranted projects would be affected, provide `manageAccessUrl` rather than working around the grant boundary.

On `needs_rebase`, reread every conflicted accepted file, rewrite against the current hashes, compile again, and finish again. Use `get_proposal_compile` only to recover an interrupted compile wait.

If the connected tools are unavailable, tell the user to install or enable the workspace LaTeX Workshop plugin in ChatGPT and authorize projects under **Mind Palace → Account settings → Agent access**. Describe this as a missing app connection, not a filesystem limitation.

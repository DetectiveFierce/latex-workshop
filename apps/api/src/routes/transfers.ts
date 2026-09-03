import { Readable } from 'node:stream';
import archiver from 'archiver';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import yauzl from 'yauzl-promise';
import type { AppConfig } from '@latex-workshop/config';
import { limits, normalizeArchivePath, type Project } from '@latex-workshop/contracts';
import {
  auditEvents,
  entries,
  fileBlobs,
  fileVersions,
  projectMemberships,
  projects,
} from '@latex-workshop/db';
import type { AppContext } from '../lib/context.js';
import { requireUser } from '../lib/context.js';
import {
  assertStorageQuota,
  buildEntryPaths,
  createCheckpoint,
  requireLibraryFolder,
  requireProject,
  sha256,
} from '../lib/domain.js';
import { badRequest, quotaExceeded } from '../lib/errors.js';

type ImportedFile = { path: string; data: Buffer };
type ImportedProject = { name: string; files: ImportedFile[] };

export async function readProjectArchive(
  buffer: Buffer,
  config: Pick<AppConfig, 'MAX_FILE_BYTES' | 'MAX_PROJECT_BYTES'>,
): Promise<ImportedFile[]> {
  const zip = await openZip(buffer, 'Project ZIP');
  const imported: ImportedFile[] = [];
  const names = new Set<string>();
  let expanded = 0;
  let count = 0;
  try {
    for await (const entry of zip as any) {
      count += 1;
      if (count > limits.maxZipEntries) throw quotaExceeded('ZIP contains too many entries');
      const path = safeArchivePath(String(entry.filename));
      const canonical = path.toLocaleLowerCase();
      if (names.has(canonical)) throw badRequest(`ZIP contains a duplicate path: ${path}`);
      names.add(canonical);
      rejectSymlink(entry);
      if (String(entry.filename).endsWith('/')) continue;
      const declaredSize = Number(entry.uncompressedSize ?? 0);
      if (declaredSize > config.MAX_FILE_BYTES)
        throw quotaExceeded(`ZIP file is too large: ${path}`);
      if (expanded + declaredSize > config.MAX_PROJECT_BYTES)
        throw quotaExceeded('Expanded ZIP is too large');
      const data = await readZipEntry(
        entry,
        config.MAX_FILE_BYTES,
        config.MAX_PROJECT_BYTES - expanded,
        path,
      );
      expanded += data.length;
      imported.push({ path, data });
    }
  } finally {
    await zip.close();
  }
  if (!imported.length) throw badRequest('ZIP does not contain files');
  return imported;
}

export async function readOverleafArchive(
  buffer: Buffer,
  config: Pick<AppConfig, 'MAX_FILE_BYTES' | 'MAX_PROJECT_BYTES' | 'MAX_USER_BYTES'>,
): Promise<ImportedProject[]> {
  const zip = await openZip(buffer, 'Overleaf export ZIP');
  const nested: Array<{ path: string; data: Buffer }> = [];
  const names = new Set<string>();
  let count = 0;
  try {
    for await (const entry of zip as any) {
      count += 1;
      if (count > limits.maxZipEntries)
        throw quotaExceeded('Overleaf export contains too many entries');
      const filename = String(entry.filename);
      const path = safeArchivePath(filename);
      const canonical = path.toLocaleLowerCase();
      if (names.has(canonical))
        throw badRequest(`Overleaf export contains a duplicate path: ${path}`);
      names.add(canonical);
      rejectSymlink(entry);
      if (filename.endsWith('/')) continue;
      if (!path.toLocaleLowerCase().endsWith('.zip'))
        throw badRequest('Overleaf export must contain only project ZIP files');
      const data = await readZipEntry(
        entry,
        config.MAX_PROJECT_BYTES,
        config.MAX_PROJECT_BYTES,
        path,
      );
      nested.push({ path, data });
    }
  } finally {
    await zip.close();
  }
  if (!nested.length) throw badRequest('Overleaf export does not contain project ZIP files');
  const projects: ImportedProject[] = [];
  let expanded = 0;
  for (const { path, data } of nested) {
    const files = await readProjectArchive(data, config);
    expanded += files.reduce((total, file) => total + file.data.length, 0);
    if (expanded > config.MAX_USER_BYTES)
      throw quotaExceeded('Combined Overleaf projects exceed the account storage limit');
    projects.push({ name: archiveProjectName(path), files });
  }
  return projects;
}

export async function registerTransferRoutes(app: FastifyInstance, context: AppContext) {
  app.post('/api/v1/projects/import', async (request, reply) => {
    const user = await requireUser(context, request);
    const folderId = (request.query as { folderId?: string }).folderId ?? null;
    if (folderId) await requireLibraryFolder(context.db, user.id, folderId);
    const part = await request.file();
    if (!part) throw badRequest('Attach a ZIP file');
    if (!part.filename.toLowerCase().endsWith('.zip'))
      throw badRequest('Only ZIP archives can be imported');
    const [projectCount] = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, user.id));
    if ((projectCount?.count ?? 0) >= context.config.MAX_PROJECTS_PER_USER)
      throw quotaExceeded('Project limit reached');
    const imported = await readProjectArchive(await part.toBuffer(), context.config);
    const rawName = archiveProjectName(part.filename);
    const project = await createImportedProject(context, user.id, rawName, imported, folderId);
    return reply.code(201).send({ project });
  });

  app.post('/api/v1/projects/import/overleaf', async (request, reply) => {
    const user = await requireUser(context, request);
    const folderId = (request.query as { folderId?: string }).folderId ?? null;
    if (folderId) await requireLibraryFolder(context.db, user.id, folderId);
    const part = await request.file();
    if (!part) throw badRequest('Attach an Overleaf export ZIP file');
    if (!part.filename.toLowerCase().endsWith('.zip'))
      throw badRequest('Only ZIP archives can be imported');
    const imports = await readOverleafArchive(await part.toBuffer(), context.config);
    const [projectCount] = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, user.id));
    const existingProjects = projectCount?.count ?? 0;
    if (existingProjects + imports.length > context.config.MAX_PROJECTS_PER_USER)
      throw quotaExceeded(
        `This export contains ${imports.length} projects, but your account has room for ${Math.max(0, context.config.MAX_PROJECTS_PER_USER - existingProjects)} more (${existingProjects} of ${context.config.MAX_PROJECTS_PER_USER} used)`,
      );
    const created: Project[] = [];
    try {
      for (const item of imports)
        created.push(
          await createImportedProject(context, user.id, item.name, item.files, folderId),
        );
    } catch (error) {
      for (const project of created)
        await context.db.delete(projects).where(eq(projects.id, project.id));
      throw error;
    }
    return reply.code(201).send({ projects: created });
  });

  async function createImportedProject(
    importContext: AppContext,
    userId: string,
    name: string,
    imported: ImportedFile[],
    folderId: string | null,
  ): Promise<Project> {
    const importedBytes = imported.reduce((total, file) => total + file.data.length, 0);
    const [project] = await importContext.db.insert(projects).values({ name }).returning();
    try {
      await importContext.db
        .insert(projectMemberships)
        .values({ projectId: project!.id, userId, role: 'owner', folderId });
      await assertStorageQuota(
        importContext.db,
        importContext.config,
        userId,
        project!.id,
        importedBytes,
      );
      const folderIds = new Map<string, string>();
      const ensureFolder = async (path: string): Promise<string | null> => {
        if (!path) return null;
        const existing = folderIds.get(path);
        if (existing) return existing;
        const slash = path.lastIndexOf('/');
        const parentPath = slash >= 0 ? path.slice(0, slash) : '';
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        const parentId = await ensureFolder(parentPath);
        const [folder] = await importContext.db
          .insert(entries)
          .values({ projectId: project!.id, parentId, name, kind: 'folder' })
          .returning();
        folderIds.set(path, folder!.id);
        return folder!.id;
      };
      let mainFileId: string | null = null;
      for (const file of imported) {
        const slash = file.path.lastIndexOf('/');
        const folderPath = slash >= 0 ? file.path.slice(0, slash) : '';
        const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
        const parentId = await ensureFolder(folderPath);
        const mimeType = /\.(tex|bib|sty|cls)$/i.test(name)
          ? 'text/x-tex'
          : 'application/octet-stream';
        const hash = sha256(file.data);
        const objectKey = `blobs/${hash.slice(0, 2)}/${hash}`;
        await importContext.storage.put(objectKey, file.data, mimeType);
        const entry = await importContext.db.transaction(async (tx) => {
          const [createdEntry] = await tx
            .insert(entries)
            .values({
              projectId: project!.id,
              parentId,
              name,
              kind: 'file',
              mimeType,
              size: file.data.length,
              version: 1,
            })
            .returning();
          await tx
            .insert(fileBlobs)
            .values({ hash, objectKey, size: file.data.length })
            .onConflictDoUpdate({
              target: fileBlobs.hash,
              set: { refCount: sql`${fileBlobs.refCount} + 1` },
            });
          const [version] = await tx
            .insert(fileVersions)
            .values({ entryId: createdEntry!.id, blobHash: hash, version: 1 })
            .returning();
          await tx
            .update(entries)
            .set({ currentVersionId: version!.id })
            .where(eq(entries.id, createdEntry!.id));
          return createdEntry!;
        });
        if (file.path === 'main.tex' || (!mainFileId && name.endsWith('.tex')))
          mainFileId = entry.id;
      }
      await importContext.db
        .update(projects)
        .set({ mainFileId, sourceRevision: 1, updatedAt: new Date() })
        .where(eq(projects.id, project!.id));
      await createCheckpoint(importContext.db, project!.id, 'import');
      await importContext.db.insert(auditEvents).values({
        userId,
        projectId: project!.id,
        action: 'project.imported',
        details: { fileCount: imported.length, bytes: importedBytes },
      });
      return {
        ...project!,
        mainFileId,
        sourceRevision: 1,
        createdAt: project!.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
        trashedAt: null,
      };
    } catch (error) {
      await importContext.db.delete(projects).where(eq(projects.id, project!.id));
      throw error;
    }
  }

  app.get('/api/v1/projects/:projectId/export', async (request, reply) => {
    const user = await requireUser(context, request);
    const { projectId } = request.params as { projectId: string };
    const project = await requireProject(context.db, user.id, projectId);
    const rows = await context.db
      .select({ entry: entries, blob: fileBlobs })
      .from(entries)
      .leftJoin(fileVersions, eq(entries.currentVersionId, fileVersions.id))
      .leftJoin(fileBlobs, eq(fileVersions.blobHash, fileBlobs.hash))
      .where(eq(entries.projectId, projectId));
    const paths = buildEntryPaths(rows.map(({ entry }) => entry));
    const safeName = project.name.replace(/[^a-zA-Z0-9._-]+/g, '-');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${safeName}.zip"`,
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (error) => reply.raw.destroy(error));
    archive.pipe(reply.raw);
    for (const row of rows) {
      const path = paths.get(row.entry.id)!;
      if (row.entry.kind === 'folder') archive.append('', { name: `${path}/` });
      else if (row.blob)
        archive.append(await context.storage.getBuffer(row.blob.objectKey), { name: path });
    }
    await archive.finalize();
  });
}

async function openZip(buffer: Buffer, label: string) {
  try {
    return await yauzl.fromBuffer(buffer, { validateFilenames: true });
  } catch {
    throw badRequest(`${label} is invalid or corrupted`);
  }
}

function safeArchivePath(filename: string): string {
  try {
    return normalizeArchivePath(filename);
  } catch {
    throw badRequest('ZIP contains an unsafe path');
  }
}

function rejectSymlink(entry: { externalFileAttributes?: number }) {
  const mode = Number(entry.externalFileAttributes ?? 0) >>> 16;
  if ((mode & 0o170000) === 0o120000) throw badRequest('ZIP symlinks are not allowed');
}

async function readZipEntry(
  entry: { openReadStream(): Promise<Readable> },
  maxBytes: number,
  projectBytesRemaining: number,
  path: string,
): Promise<Buffer> {
  const stream = (await entry.openReadStream()) as Readable;
  const chunks: Buffer[] = [];
  let actual = 0;
  for await (const chunk of stream) {
    const data = Buffer.from(chunk);
    actual += data.length;
    if (actual > maxBytes) throw quotaExceeded(`ZIP file is too large: ${path}`);
    if (actual > projectBytesRemaining) throw quotaExceeded('Expanded ZIP is too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function archiveProjectName(path: string): string {
  const filename = path.replaceAll('\\', '/').split('/').pop() ?? '';
  return (
    filename
      .replace(/\.zip$/i, '')
      .trim()
      .slice(0, 120) || 'Imported project'
  );
}

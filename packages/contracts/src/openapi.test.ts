import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './index.js';

describe('OpenAPI contract', () => {
  it('publishes the versioned surface and reusable schemas', () => {
    const document = buildOpenApiDocument('https://latex.example.test');
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/v1/projects']).toBeDefined();
    expect(document.paths['/api/v1/library']).toBeDefined();
    expect(document.paths['/api/v1/library/folders/{folderId}']).toBeDefined();
    expect(document.paths['/api/v1/library/projects/actions']).toBeDefined();
    expect(document.paths['/api/v1/projects/{projectId}/compilations/{jobId}/pdf']).toBeDefined();
    expect(document.components.schemas.ApiError).toBeDefined();
    expect(document.components.schemas.LibraryResponse).toBeDefined();
    expect(document.components.schemas.TemplateListResponse).toBeDefined();
    expect(document.paths['/api/v1/templates']).toBeDefined();
  });
});

export function mcpToolMetadata(
  kind: 'read' | 'write',
  options?: { destructive?: boolean; idempotent?: boolean },
) {
  const scopes = kind === 'read' ? ['projects:read'] : ['projects:read', 'proposals:write'];
  return {
    annotations: {
      readOnlyHint: kind === 'read',
      destructiveHint: options?.destructive ?? false,
      idempotentHint: options?.idempotent ?? true,
      openWorldHint: false,
    },
    // OpenAI clients read this compatibility mirror while OAuth remains enforced by the
    // protected-resource challenge and token verifier at the request boundary.
    _meta: { securitySchemes: [{ type: 'oauth2', scopes }] },
  };
}

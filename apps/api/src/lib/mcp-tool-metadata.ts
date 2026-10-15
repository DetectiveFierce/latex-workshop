export function mcpToolMetadata(
  kind: 'read' | 'write',
  options?: { destructive?: boolean; idempotent?: boolean },
  authentication: 'oauth' | 'private' = 'oauth',
) {
  const scopes = kind === 'read' ? ['projects:read'] : ['projects:read', 'proposals:write'];
  return {
    annotations: {
      readOnlyHint: kind === 'read',
      destructiveHint: options?.destructive ?? false,
      idempotentHint: options?.idempotent ?? true,
      openWorldHint: false,
    },
    // Private ingress authenticates the transport before tool discovery or execution.
    _meta: {
      securitySchemes:
        authentication === 'private' ? [{ type: 'noauth' }] : [{ type: 'oauth2', scopes }],
    },
  };
}

export function codexCompatibleAuthorizationMetadata(
  requestPath: string,
  body: Uint8Array,
): Uint8Array {
  if (!isAuthorizationMetadataPath(requestPath)) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
    const metadata = parsed as Record<string, unknown>;
    if (metadata.authorization_response_iss_parameter_supported !== true) return body;
    // Codex CLI 0.146.0 drops `iss` while relaying the loopback callback, then asks its
    // OAuth library to require it. Keep emitting `iss`, but do not advertise it as required.
    return new TextEncoder().encode(
      JSON.stringify({ ...metadata, authorization_response_iss_parameter_supported: false }),
    );
  } catch {
    return body;
  }
}

function isAuthorizationMetadataPath(path: string): boolean {
  const pathname = path.split('?', 1)[0] ?? path;
  return (
    pathname.includes('/.well-known/oauth-authorization-server') ||
    pathname.endsWith('/.well-known/openid-configuration')
  );
}

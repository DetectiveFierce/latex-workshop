import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '@latex-workshop/config';

export const tailnetClientId = 'mind-palace-tailnet';
export const tunnelClientId = 'mind-palace-chatgpt-tunnel';

type PrivateMcpConfig = Pick<
  AppConfig,
  'AGENT_MCP_TAILNET_KEY' | 'AGENT_MCP_TUNNEL_KEY' | 'AGENT_MCP_PRIVATE_OWNER_EMAIL'
>;

function matchesKey(expected: string | undefined, supplied: string | null): boolean {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export function trustedPrivateMcpClient(
  config: PrivateMcpConfig,
  headers: Headers,
): typeof tailnetClientId | typeof tunnelClientId | null {
  // Browser requests must not turn network membership into cross-site write access.
  if (!config.AGENT_MCP_PRIVATE_OWNER_EMAIL || headers.has('origin')) return null;
  if (matchesKey(config.AGENT_MCP_TUNNEL_KEY, headers.get('x-workshop-tunnel-key')))
    return tunnelClientId;
  if (
    matchesKey(config.AGENT_MCP_TAILNET_KEY, headers.get('x-workshop-tailnet-key')) &&
    headers.get('tailscale-user-login') === config.AGENT_MCP_PRIVATE_OWNER_EMAIL
  )
    return tailnetClientId;
  return null;
}

export function isPrivateOAuthDiscovery(
  config: PrivateMcpConfig,
  headers: Headers,
  rawUrl: string,
): boolean {
  return (
    trustedPrivateMcpClient(config, headers) !== null &&
    (rawUrl.startsWith('/.well-known/') || rawUrl.startsWith('/api/auth/.well-known/'))
  );
}

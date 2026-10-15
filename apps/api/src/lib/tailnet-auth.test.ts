import { describe, expect, it } from 'vitest';
import {
  isPrivateOAuthDiscovery,
  tailnetClientId,
  trustedPrivateMcpClient,
  tunnelClientId,
} from './tailnet-auth.js';

const config = {
  AGENT_MCP_TAILNET_KEY: 'a'.repeat(64),
  AGENT_MCP_TUNNEL_KEY: 'b'.repeat(64),
  AGENT_MCP_PRIVATE_OWNER_EMAIL: 'owner@example.com',
};
const tailnetHeaders = {
  'x-workshop-tailnet-key': config.AGENT_MCP_TAILNET_KEY,
  'tailscale-user-login': config.AGENT_MCP_PRIVATE_OWNER_EMAIL,
};

describe('private MCP authentication', () => {
  it('requires both an ingress credential and the exact Serve identity for tailnet devices', () => {
    expect(trustedPrivateMcpClient(config, new Headers(tailnetHeaders))).toBe(tailnetClientId);
    for (const headers of [
      {},
      { 'tailscale-user-login': config.AGENT_MCP_PRIVATE_OWNER_EMAIL },
      { ...tailnetHeaders, 'tailscale-user-login': 'other@example.com' },
      { ...tailnetHeaders, 'tailscale-user-login': 'owner@example.com, other@example.com' },
      { ...tailnetHeaders, 'x-workshop-tailnet-key': 'short' },
      { ...tailnetHeaders, 'x-workshop-tailnet-key': 'z'.repeat(64) },
    ])
      expect(trustedPrivateMcpClient(config, new Headers(headers))).toBeNull();
  });

  it('authenticates the private hosted tunnel with its independent service credential', () => {
    expect(
      trustedPrivateMcpClient(
        config,
        new Headers({
          'x-workshop-tunnel-key': config.AGENT_MCP_TUNNEL_KEY,
          authorization: 'Bearer expired-oauth-token',
        }),
      ),
    ).toBe(tunnelClientId);
    expect(
      trustedPrivateMcpClient(
        config,
        new Headers({
          'x-workshop-tunnel-key': config.AGENT_MCP_TAILNET_KEY,
        }),
      ),
    ).toBeNull();
  });

  it.each(['https://evil.example', 'null', 'https://workshop.example'])(
    'refuses browser origins even with a valid credential: %s',
    (origin) => {
      expect(
        trustedPrivateMcpClient(config, new Headers({ ...tailnetHeaders, origin })),
      ).toBeNull();
      expect(
        trustedPrivateMcpClient(
          config,
          new Headers({
            'x-workshop-tunnel-key': config.AGENT_MCP_TUNNEL_KEY,
            origin,
          }),
        ),
      ).toBeNull();
    },
  );

  it('fails closed when private access or its owner mapping is disabled', () => {
    expect(trustedPrivateMcpClient({}, new Headers(tailnetHeaders))).toBeNull();
    expect(
      trustedPrivateMcpClient(
        { ...config, AGENT_MCP_PRIVATE_OWNER_EMAIL: undefined },
        new Headers(tailnetHeaders),
      ),
    ).toBeNull();
  });
  it('keeps OAuth discovery for regular clients and hides it only on authenticated private metadata requests', () => {
    const headers = new Headers({ 'x-workshop-tunnel-key': config.AGENT_MCP_TUNNEL_KEY });
    expect(isPrivateOAuthDiscovery(config, headers, '/.well-known/oauth-protected-resource')).toBe(
      true,
    );
    expect(
      isPrivateOAuthDiscovery(config, headers, '/api/auth/.well-known/oauth-authorization-server'),
    ).toBe(true);
    expect(
      isPrivateOAuthDiscovery(config, new Headers(), '/.well-known/oauth-protected-resource'),
    ).toBe(false);
    expect(isPrivateOAuthDiscovery(config, headers, '/api/auth/sign-in/email')).toBe(false);
  });
});

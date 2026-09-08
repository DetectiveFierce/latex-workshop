export const mcpHandlerOptions = {
  // Codex currently negotiates the 2025-06-18 protocol. Keep the SDK's stateless
  // compatibility leg alongside the modern 2026 per-request transport.
  legacy: 'stateless',
  responseMode: 'auto',
  maxSubscriptions: 100,
  keepAliveMs: 15_000,
} as const;

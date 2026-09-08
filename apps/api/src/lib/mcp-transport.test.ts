import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { mindPalaceMcpInstructions, mindPalaceMcpServerName } from './mcp-agent-guide.js';
import { mcpHandlerOptions } from './mcp-transport.js';

const initializeResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({
    protocolVersion: z.string(),
    serverInfo: z.object({ name: z.string() }),
    instructions: z.string(),
  }),
});

describe('MCP transport compatibility', () => {
  it('serves the 2025-06-18 protocol currently negotiated by Codex', async () => {
    const handler = createMcpHandler(
      () =>
        new McpServer(
          { name: mindPalaceMcpServerName, version: '0.5.0' },
          { instructions: mindPalaceMcpInstructions },
        ),
      mcpHandlerOptions,
    );
    try {
      const response = await handler.fetch(
        new Request('https://mind-palace.example/latex-workshop/api/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'Codex', version: 'test' },
            },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.text();
      const data = response.headers.get('content-type')?.includes('text/event-stream')
        ? body
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
            .trim()
        : body;
      expect(data).toBeTruthy();
      const message = initializeResponseSchema.parse(JSON.parse(data ?? 'null'));
      expect(message.result.protocolVersion).toBe('2025-06-18');
      expect(message.result.serverInfo.name).toBe('Mind Palace LaTeX Workshop');
      expect(message.result.instructions).toContain('Mind Palace site');
    } finally {
      await handler.close();
    }
  });
});

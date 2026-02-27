#!/usr/bin/env node
/**
 * NeuralDiff MCP Server
 *
 * Exposes the NeuralDiff daemon (localhost:7878) as MCP tools
 * for AI assistants to drive screenshot capture and visual comparison.
 *
 * Usage:
 *   claude mcp add neuraldiff -- node /path/to/neuraldiff-mcp/dist/index.js
 *   # Or with custom daemon URL:
 *   NEURALDIFF_DAEMON_URL=http://localhost:9000 node dist/index.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const DAEMON_URL = process.env.NEURALDIFF_DAEMON_URL || 'http://localhost:7878';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function daemonFetch(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(`${DAEMON_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {
        error: 'Cannot reach NeuralDiff daemon',
        message: err instanceof Error ? err.message : String(err),
        hint: `Is the daemon running? Start it with: cd neuraldiff-api && npm run dev`,
      },
    };
  }
}

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'neuraldiff',
  version: '1.0.0',
});

// 1. Health check
server.registerTool(
  'neuraldiff_health',
  {
    title: 'NeuralDiff Health',
    description:
      'Check if the NeuralDiff daemon is running. Returns status, browser connection, and capture count.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/health');
    if (!ok) return errorResult('Daemon is not reachable');
    return jsonResult(data);
  }
);

// 2. Capture screenshot
server.registerTool(
  'neuraldiff_capture',
  {
    title: 'Capture Screenshot',
    description:
      'Capture a screenshot of a URL using the NeuralDiff daemon. Returns capture ID, perceptual hash, dimensions, and file size.',
    inputSchema: z.object({
      id: z.string().describe('Unique identifier for this capture (e.g. "dashboard-desktop")'),
      url: z.string().describe('Full URL to capture (e.g. "http://localhost:3000/dashboard")'),
      viewport: z
        .object({
          width: z.number().describe('Viewport width in pixels'),
          height: z.number().describe('Viewport height in pixels'),
          deviceScaleFactor: z.number().optional().describe('Device pixel ratio (default 1)'),
          isMobile: z.boolean().optional().describe('Emulate mobile device'),
        })
        .optional()
        .describe('Browser viewport dimensions'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page (default false)'),
      waitFor: z
        .union([z.string(), z.number()])
        .optional()
        .describe('CSS selector to wait for, or milliseconds to wait'),
    }),
  },
  async ({ id, url, viewport, fullPage, waitFor }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { id, url };
    if (viewport) body.viewport = viewport;
    if (fullPage !== undefined) body.fullPage = fullPage;
    if (waitFor !== undefined) body.waitFor = waitFor;

    const { ok, data } = await daemonFetch('/api/screenshots', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!ok) return errorResult(`Capture failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 3. Quick compare (aHash)
server.registerTool(
  'neuraldiff_compare_quick',
  {
    title: 'Quick Visual Compare',
    description:
      'Fast perceptual hash comparison between two captures using aHash. Returns similarity score (0-1) and whether full analysis is recommended. Sub-second response.',
    inputSchema: z.object({
      baselineId: z.string().describe('ID of the baseline capture'),
      currentId: z.string().describe('ID of the current capture to compare against baseline'),
    }),
  },
  async ({ baselineId, currentId }): Promise<CallToolResult> => {
    const params = new URLSearchParams({
      baselineId,
      currentId,
      algorithm: 'quick',
    });
    const { ok, data } = await daemonFetch(`/api/compare/quick?${params}`);
    if (!ok) return errorResult(`Quick compare failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 4. Robust compare (multi-algorithm consensus)
server.registerTool(
  'neuraldiff_compare_robust',
  {
    title: 'Robust Visual Compare',
    description:
      'Multi-algorithm perceptual hash comparison (dHash + aHash consensus). More accurate but slower. Returns per-algorithm results and consensus score.',
    inputSchema: z.object({
      baselineId: z.string().describe('ID of the baseline capture'),
      currentId: z.string().describe('ID of the current capture to compare against baseline'),
    }),
  },
  async ({ baselineId, currentId }): Promise<CallToolResult> => {
    const params = new URLSearchParams({
      baselineId,
      currentId,
      algorithm: 'robust',
    });
    const { ok, data } = await daemonFetch(`/api/compare/quick?${params}`);
    if (!ok) return errorResult(`Robust compare failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 5. List captures
server.registerTool(
  'neuraldiff_list_captures',
  {
    title: 'List Captures',
    description:
      'List all screenshot captures stored in the daemon. Returns capture IDs, routes, viewports, timestamps, and file sizes.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/screenshots');
    if (!ok) return errorResult(`Failed to list captures: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 6. Get capture metadata
server.registerTool(
  'neuraldiff_get_capture',
  {
    title: 'Get Capture',
    description:
      'Get full metadata for a specific screenshot capture by ID, including perceptual hash, dimensions, viewport, and file paths.',
    inputSchema: z.object({
      id: z.string().describe('The capture ID to retrieve'),
    }),
  },
  async ({ id }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/screenshots/${encodeURIComponent(id)}`);
    if (!ok) return errorResult(`Capture not found: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 7. Delete capture
server.registerTool(
  'neuraldiff_delete_capture',
  {
    title: 'Delete Capture',
    description: 'Delete a screenshot capture and its files from the daemon.',
    inputSchema: z.object({
      id: z.string().describe('The capture ID to delete'),
    }),
  },
  async ({ id }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/screenshots/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!ok) return errorResult(`Delete failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`NeuralDiff MCP server running (daemon: ${DAEMON_URL})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

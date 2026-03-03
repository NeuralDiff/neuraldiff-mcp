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

import { evaluate } from './escalation.js';
import { anyPatternWarrantsEscalation, matchPatterns } from './patterns.js';
import type {
  AnalysisResult,
  DaemonAnalysisResult,
  QuickCompareResult,
} from './types.js';

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
  version: '1.1.0',
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

// 8. Full analysis pipeline (with auto-escalation)
server.registerTool(
  'neuraldiff_analyze',
  {
    title: 'Full Analysis Pipeline',
    description:
      'Run a full visual regression analysis. Performs a quick hash comparison first, ' +
      'then matches results against known regression patterns. If similarity is below ' +
      'the escalation threshold (default 0.98), automatically escalates to the daemon ' +
      'for deep pixel-level analysis. Returns quick-compare data, matched patterns, ' +
      'escalation decision, and (when escalated) deep analysis results.',
    inputSchema: z.object({
      baselineId: z.string().describe('ID of the baseline capture'),
      currentId: z.string().describe('ID of the current capture to compare'),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Similarity threshold below which to auto-escalate (0–1, default 0.98)'
        ),
    }),
  },
  async ({ baselineId, currentId, threshold }): Promise<CallToolResult> => {
    // Step 1 – Quick compare
    const params = new URLSearchParams({
      baselineId,
      currentId,
      algorithm: 'quick',
    });
    const quickRes = await daemonFetch(`/api/compare/quick?${params}`);
    if (!quickRes.ok) {
      return errorResult(`Quick compare failed: ${JSON.stringify(quickRes.data)}`);
    }

    const quickCompare = quickRes.data as QuickCompareResult;

    // Step 2 – Pattern matching
    const matchedPatterns = matchPatterns(quickCompare);

    // Step 3 – Escalation decision
    const thresholds = threshold
      ? { ...( await import('./escalation.js') ).DEFAULT_THRESHOLDS, autoEscalate: threshold }
      : undefined;
    const escalation = evaluate(quickCompare, matchedPatterns, thresholds);

    // Step 4 – Deep analysis (only when escalated)
    let deepAnalysis: DaemonAnalysisResult | null = null;

    if (escalation.shouldEscalate) {
      const analyzeRes = await daemonFetch('/api/analyze', {
        method: 'POST',
        body: JSON.stringify({
          baselineId,
          currentId,
          priority: escalation.priority,
          reasons: escalation.reasons,
        }),
      });

      if (analyzeRes.ok) {
        deepAnalysis = analyzeRes.data as DaemonAnalysisResult;
      }
      // If deep analysis fails we still return what we have – the quick
      // compare + pattern data is valuable on its own.
    }

    const result: AnalysisResult = {
      quickCompare,
      matchedPatterns,
      escalation,
      deepAnalysis,
      timestamp: new Date().toISOString(),
    };

    return jsonResult(result);
  }
);

// 9. Set baseline
server.registerTool(
  'neuraldiff_baseline_set',
  {
    title: 'Set Baseline',
    description:
      'Designate a capture as the baseline for a given name (typically a route or page). ' +
      'Future comparisons can reference this baseline by name.',
    inputSchema: z.object({
      captureId: z.string().describe('ID of the capture to use as the baseline'),
      name: z
        .string()
        .describe(
          'Logical name for the baseline (e.g. "homepage-desktop", "/dashboard")'
        ),
    }),
  },
  async ({ captureId, name }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/baselines', {
      method: 'POST',
      body: JSON.stringify({ captureId, name }),
    });
    if (!ok) return errorResult(`Failed to set baseline: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 10. Get baseline
server.registerTool(
  'neuraldiff_baseline_get',
  {
    title: 'Get Baseline',
    description:
      'Retrieve the current baseline capture for a given name. Returns the capture ID, ' +
      'metadata, and when the baseline was set.',
    inputSchema: z.object({
      name: z.string().describe('Baseline name to look up'),
    }),
  },
  async ({ name }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(
      `/api/baselines/${encodeURIComponent(name)}`
    );
    if (!ok) return errorResult(`Baseline not found: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 11. Start watching a URL
server.registerTool(
  'neuraldiff_watch_start',
  {
    title: 'Start Watch',
    description:
      'Start periodically capturing screenshots of a URL and comparing against its ' +
      'baseline. The daemon will poll at the given interval and flag regressions.',
    inputSchema: z.object({
      url: z.string().describe('URL to watch for visual changes'),
      intervalMs: z
        .number()
        .optional()
        .describe('Polling interval in milliseconds (default daemon-configured)'),
      viewport: z
        .object({
          width: z.number().describe('Viewport width in pixels'),
          height: z.number().describe('Viewport height in pixels'),
          deviceScaleFactor: z.number().optional().describe('Device pixel ratio'),
          isMobile: z.boolean().optional().describe('Emulate mobile device'),
        })
        .optional()
        .describe('Viewport for captures'),
      waitFor: z
        .union([z.string(), z.number()])
        .optional()
        .describe('CSS selector or ms to wait before capture'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page'),
    }),
  },
  async ({ url, intervalMs, viewport, waitFor, fullPage }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { url };
    if (intervalMs !== undefined) body.intervalMs = intervalMs;
    if (viewport) body.viewport = viewport;
    if (waitFor !== undefined) body.waitFor = waitFor;
    if (fullPage !== undefined) body.fullPage = fullPage;

    const { ok, data } = await daemonFetch('/api/watch', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!ok) return errorResult(`Failed to start watch: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 12. Stop watching
server.registerTool(
  'neuraldiff_watch_stop',
  {
    title: 'Stop Watch',
    description: 'Stop a previously started URL watch by its watch ID.',
    inputSchema: z.object({
      id: z.string().describe('Watch ID to stop'),
    }),
  },
  async ({ id }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(
      `/api/watch/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    if (!ok) return errorResult(`Failed to stop watch: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// 13. Send session / change context
server.registerTool(
  'neuraldiff_session_context',
  {
    title: 'Send Session Context',
    description:
      'Send developer intent and chat context to the daemon so it (and the upstream API) ' +
      'can understand *why* visual changes were made. This helps distinguish intentional ' +
      'redesigns from accidental regressions.',
    inputSchema: z.object({
      changeIntent: z
        .string()
        .describe(
          'Short summary of what the developer intends to change ' +
          '(e.g. "Redesigning the pricing card layout")'
        ),
      chatHistorySummary: z
        .string()
        .optional()
        .describe('Condensed summary of recent chat / instructions'),
      affectedRoutes: z
        .array(z.string())
        .optional()
        .describe('Routes or pages likely affected by the change'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Arbitrary key-value metadata'),
    }),
  },
  async ({
    changeIntent,
    chatHistorySummary,
    affectedRoutes,
    metadata,
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { changeIntent };
    if (chatHistorySummary !== undefined) body.chatHistorySummary = chatHistorySummary;
    if (affectedRoutes !== undefined) body.affectedRoutes = affectedRoutes;
    if (metadata !== undefined) body.metadata = metadata;

    const { ok, data } = await daemonFetch('/api/context', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!ok)
      return errorResult(`Failed to send session context: ${JSON.stringify(data)}`);
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

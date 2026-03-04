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
  version: '1.2.0',
});

// ---------------------------------------------------------------------------
// Diffy — NeuralDiff's opinionated visual regression agent
// ---------------------------------------------------------------------------

const DIFFY_VERDICTS = {
  clean: [
    'Nothing broken. You may merge.',
    'Visually identical. Carry on.',
    'Clean. I checked everything — unlike some tools.',
    'No regressions. Your UI lives another day.',
  ],
  minor: [
    'Found something. It\'s small, but I don\'t let things slide.',
    'Minor change detected. Percy would have missed this.',
    'Subtle shift. Most tools would call this "noise." I call it a finding.',
  ],
  moderate: [
    'This needs attention. Your UI changed in ways you should review.',
    'Significant visual delta. Don\'t even think about merging without looking.',
    'I found real changes. The kind that pixel-diffing tools wave through.',
  ],
  critical: [
    'Major regression. This is not a drill.',
    'Your UI is broken. I caught it in 6ms. You\'re welcome.',
    'Critical visual failure. The kind Percy charges $149/mo to maybe find.',
  ],
  error: [
    'Something went wrong on my end. Even I\'m not perfect — just close.',
  ],
} as const;

function pickVerdict(severity: 'clean' | 'minor' | 'moderate' | 'critical' | 'error'): string {
  const pool = DIFFY_VERDICTS[severity];
  return pool[Math.floor(Math.random() * pool.length)];
}

function getSeverityFromSimilarity(similarity: number): 'clean' | 'minor' | 'moderate' | 'critical' {
  if (similarity >= 0.98) return 'clean';
  if (similarity >= 0.90) return 'minor';
  if (similarity >= 0.75) return 'moderate';
  return 'critical';
}

// 1. Health check
server.registerTool(
  'neuraldiff_health',
  {
    title: 'Diffy Health Check',
    description:
      'Check if Diffy (the NeuralDiff daemon) is awake and ready. Returns status, browser connection, and capture count.',
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
    title: 'Diffy Capture',
    description:
      'Have Diffy capture a screenshot of a URL. Returns capture ID, perceptual hash, dimensions, and file size. Diffy remembers everything.',
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
    title: 'Diffy Quick Compare',
    description:
      'Diffy\'s fast perceptual hash comparison (aHash). Returns similarity score (0-1) in under 8ms. If something looks off, Diffy will tell you to escalate.',
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
    title: 'Diffy Robust Compare',
    description:
      'Diffy\'s thorough multi-algorithm comparison (dHash + aHash consensus). Slower than quick, but Diffy doesn\'t cut corners when it matters.',
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
    title: 'Diffy List Captures',
    description:
      'List everything Diffy has captured. Returns capture IDs, routes, viewports, timestamps, and file sizes.',
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
    title: 'Diffy Get Capture',
    description:
      'Get full metadata for a capture by ID — hash, dimensions, viewport, file paths. Diffy keeps meticulous records.',
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
    title: 'Diffy Delete Capture',
    description: 'Delete a capture. Diffy doesn\'t forget — but he can be told to.',
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
    title: 'Diffy Analyze',
    description:
      'Diffy\'s full visual regression analysis. Fast hash check first, pattern matching second, ' +
      'deep pixel analysis only when warranted. Most checks finish in 6-8ms. ' +
      'Diffy will tell you exactly what changed and whether you should care. ' +
      'Returns verdict, quick-compare data, matched patterns, escalation decision, ' +
      'and (when escalated) deep analysis results.',
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

    const severity = getSeverityFromSimilarity(quickCompare.similarity ?? 1);
    const verdict = pickVerdict(severity);

    const result: AnalysisResult = {
      diffy: { verdict, severity },
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
    title: 'Diffy Set Baseline',
    description:
      'Lock in a capture as the baseline. Diffy will judge all future captures against it.',
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
    title: 'Diffy Get Baseline',
    description:
      'Retrieve the current baseline for a given name. This is what Diffy compares against.',
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
    title: 'Diffy Start Watch',
    description:
      'Put Diffy on patrol. He\'ll periodically capture a URL and compare against its ' +
      'baseline. If something changes, Diffy will let you know.',
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
    title: 'Diffy Stop Watch',
    description: 'Call Diffy off patrol for a watched URL.',
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
    title: 'Diffy Session Context',
    description:
      'Tell Diffy what you\'re working on. He\'ll use this context to distinguish intentional ' +
      'redesigns from accidental regressions. Diffy judges less harshly when he knows the plan.',
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
  console.error(`Diffy is awake. NeuralDiff MCP server running (daemon: ${DAEMON_URL})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

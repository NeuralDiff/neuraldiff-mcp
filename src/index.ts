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
// Projects
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_list_projects',
  {
    title: 'List Projects',
    description:
      'List all NeuralDiff projects. Each project groups environments, personas, and page records.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/projects');
    if (!ok) return errorResult(`Failed to list projects: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_create_project',
  {
    title: 'Create Project',
    description:
      'Create a new NeuralDiff project. A project groups environments (local, staging, prod), personas, and page records for a web app.',
    inputSchema: z.object({
      name: z.string().describe('Project name (e.g. "My SaaS App")'),
      url: z.string().optional().describe('Single URL — creates a "local" environment. Use this OR environments, not both.'),
      environments: z
        .array(z.object({
          name: z.string().describe('Environment name (e.g. "local", "staging", "prod")'),
          url: z.string().describe('Base URL for this environment'),
          loginPath: z.string().optional().describe('Path to login page (e.g. "/login")'),
        }))
        .optional()
        .describe('Multiple environments. Use this OR url, not both.'),
      id: z.string().optional().describe('Custom project ID (auto-generated from name if omitted)'),
      description: z.string().optional().describe('Project description'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to create project: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_get_project',
  {
    title: 'Get Project',
    description:
      'Get a project by ID, including its environments, personas, QA sessions, and total findings count.',
    inputSchema: z.object({
      id: z.string().describe('Project ID'),
    }),
  },
  async ({ id }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!ok) return errorResult(`Project not found: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_update_project',
  {
    title: 'Update Project',
    description: 'Update a project. Partial update — only provided fields are changed.',
    inputSchema: z.object({
      id: z.string().describe('Project ID'),
      name: z.string().optional().describe('New project name'),
      description: z.string().optional().describe('New description'),
      environments: z
        .array(z.object({
          name: z.string(),
          url: z.string(),
          loginPath: z.string().optional(),
        }))
        .optional()
        .describe('Replace environments list'),
    }),
  },
  async ({ id, ...body }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!ok) return errorResult(`Failed to update project: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_delete_project',
  {
    title: 'Delete Project',
    description: 'Delete a project and all its data.',
    inputSchema: z.object({
      id: z.string().describe('Project ID to delete'),
    }),
  },
  async ({ id }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!ok) return errorResult(`Failed to delete project: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Project Pages & Nav Map
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_list_pages',
  {
    title: 'List Project Pages',
    description:
      'List all discovered pages for a project. Pages are auto-populated from QA crawls and can be annotated.',
    inputSchema: z.object({
      projectId: z.string().describe('Project ID'),
    }),
  },
  async ({ projectId }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/projects/${encodeURIComponent(projectId)}/pages`);
    if (!ok) return errorResult(`Failed to list pages: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_annotate_page',
  {
    title: 'Annotate Page',
    description:
      'Annotate a discovered page with intent, access rules, expected/unexpected elements, or notes.',
    inputSchema: z.object({
      projectId: z.string().describe('Project ID'),
      path: z.string().describe('Page path (e.g. "/dashboard", "/settings/billing")'),
      intent: z.string().optional().describe('What this page is for (e.g. "User dashboard showing key metrics")'),
      personaAccess: z.array(z.string()).optional().describe('Which personas should access this page'),
      shouldShow: z.array(z.string()).optional().describe('Elements that should be visible on this page'),
      shouldNotShow: z.array(z.string()).optional().describe('Elements that should NOT appear on this page'),
      notes: z.string().optional().describe('Free-form notes about this page'),
    }),
  },
  async ({ projectId, path, ...body }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(
      `/api/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(path)}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    if (!ok) return errorResult(`Failed to annotate page: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_get_navmap',
  {
    title: 'Get Navigation Map',
    description:
      'Get the navigation graph for a project — nodes (pages with types, intents, findings) and edges (links between pages). Useful for understanding site structure.',
    inputSchema: z.object({
      projectId: z.string().describe('Project ID'),
    }),
  },
  async ({ projectId }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/projects/${encodeURIComponent(projectId)}/navmap`);
    if (!ok) return errorResult(`Failed to get navmap: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_merge_pages',
  {
    title: 'Merge Session Pages',
    description:
      'Merge a completed QA session\'s discovered pages into the project\'s page registry. Returns counts of pages added and updated.',
    inputSchema: z.object({
      projectId: z.string().describe('Project ID'),
      sessionId: z.string().describe('QA session ID whose pages to merge'),
    }),
  },
  async ({ projectId, sessionId }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(
      `/api/projects/${encodeURIComponent(projectId)}/merge-pages`,
      { method: 'POST', body: JSON.stringify({ sessionId }) }
    );
    if (!ok) return errorResult(`Failed to merge pages: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// QA Runs
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_qa_run',
  {
    title: 'Run QA Session',
    description:
      'Start a full QA session — crawls the site and runs AI analysis on each page (plan-gated). Returns immediately with a session ID; the run executes async. Use neuraldiff_get_session to check progress.',
    inputSchema: z.object({
      targetUrl: z.string().describe('URL to start crawling from'),
      projectId: z.string().optional().describe('Project ID — enables persona resolution and auto-merges pages on completion'),
      env: z.string().optional().describe('Project environment name (default "local") — determines which loginPath to use'),
      personas: z.array(z.string()).optional().describe('Persona names to run as. Use ["*"] for all personas in the project.'),
      maxPages: z.number().optional().describe('Max pages to crawl (default 50, capped by plan)'),
      maxDepth: z.number().optional().describe('Max link depth (default 5)'),
      skipPatterns: z.array(z.string()).optional().describe('URL regex patterns to skip'),
      skipCategories: z.array(z.string()).optional().describe('Test categories to skip (e.g. "responsive")'),
      enableAIAnalysis: z.boolean().optional().describe('Enable AI-powered analysis (requires paid plan)'),
      concurrency: z.number().optional().describe('Parallel page analysis (default 1)'),
      timeoutPerPage: z.number().optional().describe('Timeout per page in ms (default 15000)'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/qa/run', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to start QA run: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_qa_crawl',
  {
    title: 'Crawl Only',
    description:
      'Start a crawl-only session — discovers pages and captures screenshots but skips AI analysis. Faster and free regardless of plan. Returns session ID.',
    inputSchema: z.object({
      targetUrl: z.string().describe('URL to start crawling from'),
      projectId: z.string().optional().describe('Project ID'),
      env: z.string().optional().describe('Project environment name (default "local")'),
      personas: z.array(z.string()).optional().describe('Persona names to run as'),
      maxPages: z.number().optional().describe('Max pages to crawl (default 50)'),
      maxDepth: z.number().optional().describe('Max link depth (default 5)'),
      skipPatterns: z.array(z.string()).optional().describe('URL regex patterns to skip'),
      concurrency: z.number().optional().describe('Parallel crawling (default 1)'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/qa/crawl', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to start crawl: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_list_sessions',
  {
    title: 'List QA Sessions',
    description:
      'List all QA sessions (running and completed). Returns status, progress, finding counts, and site map summaries.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/qa/sessions');
    if (!ok) return errorResult(`Failed to list sessions: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_get_session',
  {
    title: 'Get QA Session',
    description:
      'Get details for a specific QA session by ID. Use full=true to include complete page data and snapshots.',
    inputSchema: z.object({
      id: z.string().describe('Session ID'),
      full: z.boolean().optional().describe('Include full siteMap pages and snapshots (default false)'),
    }),
  },
  async ({ id, full }): Promise<CallToolResult> => {
    const query = full ? '?full=true' : '';
    const { ok, data } = await daemonFetch(`/api/qa/sessions/${encodeURIComponent(id)}${query}`);
    if (!ok) return errorResult(`Session not found: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Watch Mode
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_watch_start',
  {
    title: 'Start Watch Mode',
    description:
      'Start watching a URL — runs QA on a repeating interval. First run starts immediately. Returns a watch ID for stopping later.',
    inputSchema: z.object({
      targetUrl: z.string().describe('URL to watch'),
      intervalSeconds: z.number().optional().describe('Repeat interval in seconds (default 60, minimum 30)'),
      maxPages: z.number().optional().describe('Max pages per run'),
      skipCategories: z.array(z.string()).optional().describe('Test categories to skip'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/qa/watch', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to start watch: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_watch_stop',
  {
    title: 'Stop Watch',
    description: 'Stop a running watch by its watch ID.',
    inputSchema: z.object({
      watchId: z.string().describe('Watch ID to stop'),
    }),
  },
  async ({ watchId }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(`/api/qa/watch/${encodeURIComponent(watchId)}`, {
      method: 'DELETE',
    });
    if (!ok) return errorResult(`Failed to stop watch: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_watch_list',
  {
    title: 'List Active Watches',
    description: 'List all active watch mode monitors with their URLs, intervals, and status.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/qa/watch');
    if (!ok) return errorResult(`Failed to list watches: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_list_personas',
  {
    title: 'List Personas',
    description:
      'List all test personas across all projects. Personas represent different user roles for authenticated QA testing. Passwords are masked.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/personas');
    if (!ok) return errorResult(`Failed to list personas: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_create_persona',
  {
    title: 'Create Persona',
    description:
      'Create a test persona for a project. Personas drive authenticated QA — each persona logs in and tests the app from their role\'s perspective.',
    inputSchema: z.object({
      projectId: z.string().describe('Project ID to add the persona to'),
      name: z.string().describe('Persona name (e.g. "admin", "free-user")'),
      email: z.string().describe('Login email'),
      password: z.string().describe('Login password'),
      role: z.string().describe('User role (e.g. "admin", "editor", "viewer")'),
      purpose: z.string().describe('What this persona tests (e.g. "Verify admin dashboard access controls")'),
      workflows: z.array(z.string()).optional().describe('Specific workflows to test (e.g. ["create post", "manage users"])'),
      authType: z.enum(['credentials', 'form-login']).optional().describe('Auth method (default "credentials")'),
      selectors: z.object({
        username: z.string(),
        password: z.string(),
        submit: z.string(),
      }).optional().describe('CSS selectors for login form fields (required when authType is "form-login")'),
      tags: z.array(z.string()).optional().describe('Tags for filtering'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/personas', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to create persona: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_test_persona',
  {
    title: 'Test Persona Login',
    description:
      'Live-test a persona\'s credentials by driving a real browser login. Returns success/failure, final URL, and diagnostics.',
    inputSchema: z.object({
      name: z.string().describe('Persona name'),
      projectId: z.string().describe('Project ID the persona belongs to'),
      env: z.string().optional().describe('Environment to test against (default "local")'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/personas/test', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Persona test failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_delete_persona',
  {
    title: 'Delete Persona',
    description: 'Remove a persona from a project.',
    inputSchema: z.object({
      name: z.string().describe('Persona name to delete'),
      projectId: z.string().describe('Project ID the persona belongs to'),
    }),
  },
  async ({ name, projectId }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch(
      `/api/personas/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' }
    );
    if (!ok) return errorResult(`Failed to delete persona: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Corrections / Knowledge Base
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_list_corrections',
  {
    title: 'List Corrections',
    description:
      'List all learned corrections in the knowledge base. Corrections are fixes derived from QA findings that improve future runs.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/corrections');
    if (!ok) return errorResult(`Failed to list corrections: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_create_correction',
  {
    title: 'Create Correction',
    description:
      'Create a new correction in the knowledge base. Corrections teach NeuralDiff about known issues and their fixes.',
    inputSchema: z.object({
      defectPattern: z.string().describe('Stable key for deduplication (e.g. "missing-alt-text-hero-image")'),
      category: z.enum([
        'form-validation', 'navigation', 'responsive', 'accessibility',
        'error-handling', 'state-management', 'ai-review', 'design-review', 'perception',
      ]).describe('Correction category'),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).describe('Severity level'),
      pageUrl: z.string().describe('URL where the issue was found'),
      title: z.string().describe('Short title for the correction'),
      description: z.string().describe('What the problem is'),
      fix: z.string().describe('How to fix it'),
      selector: z.string().optional().describe('CSS selector that triggered the finding'),
      findingId: z.string().optional().describe('ID of the originating QA finding'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/corrections', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Failed to create correction: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_corrections_sync_status',
  {
    title: 'Corrections Sync Status',
    description:
      'Check the cloud sync status for corrections — last pull/push times, pending count, connection state.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/corrections/sync');
    if (!ok) return errorResult(`Failed to get sync status: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_corrections_sync',
  {
    title: 'Sync Corrections',
    description:
      'Trigger an immediate bidirectional sync of corrections with the cloud. Pulls new corrections, then pushes local ones. Requires cloud connection.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/corrections/sync', { method: 'POST' });
    if (!ok) return errorResult(`Sync failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Cloud Connection
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_cloud_connect',
  {
    title: 'Connect to Cloud',
    description:
      'Connect the local daemon to NeuralDiff Cloud using an API key. Validates the key, stores plan info, and starts correction sync.',
    inputSchema: z.object({
      apiKey: z.string().describe('NeuralDiff Cloud API key'),
    }),
  },
  async ({ apiKey }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/cloud/connect', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });
    if (!ok) return errorResult(`Cloud connect failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_cloud_disconnect',
  {
    title: 'Disconnect from Cloud',
    description: 'Disconnect the daemon from NeuralDiff Cloud. Clears credentials and resets plan to free.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/cloud/disconnect', { method: 'POST' });
    if (!ok) return errorResult(`Cloud disconnect failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_cloud_status',
  {
    title: 'Cloud Status',
    description: 'Check cloud connection status — connected state, plan tier, org name, and user.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/cloud/status');
    if (!ok) return errorResult(`Failed to get cloud status: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Auth (Cloud Login/Signup)
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_auth_login',
  {
    title: 'Login',
    description:
      'Log in to NeuralDiff Cloud with email and password. Stores session in daemon and starts correction sync.',
    inputSchema: z.object({
      email: z.string().describe('Account email'),
      password: z.string().describe('Account password'),
    }),
  },
  async ({ email, password }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!ok) return errorResult(`Login failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_auth_signup',
  {
    title: 'Sign Up',
    description: 'Create a new NeuralDiff Cloud account. May require email confirmation.',
    inputSchema: z.object({
      email: z.string().describe('Email for the new account'),
      password: z.string().describe('Password'),
      name: z.string().optional().describe('Display name'),
    }),
  },
  async (args): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return errorResult(`Signup failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_auth_logout',
  {
    title: 'Logout',
    description: 'Log out of NeuralDiff Cloud. Clears all session state from the daemon.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/auth/logout', { method: 'POST' });
    if (!ok) return errorResult(`Logout failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_auth_me',
  {
    title: 'Current User',
    description: 'Check who is currently logged in. Returns user info and org, or loggedIn=false.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/auth/me');
    if (!ok) return errorResult(`Failed to check auth: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_auth_token',
  {
    title: 'Set Auth Token',
    description:
      'Authenticate with a pre-existing access token (e.g. from an OAuth redirect). Verifies against cloud and stores session.',
    inputSchema: z.object({
      accessToken: z.string().describe('Access token from external auth flow'),
    }),
  },
  async ({ accessToken }): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ accessToken }),
    });
    if (!ok) return errorResult(`Token auth failed: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

// ---------------------------------------------------------------------------
// Plan & AI
// ---------------------------------------------------------------------------

server.registerTool(
  'neuraldiff_plan_features',
  {
    title: 'Plan Features',
    description:
      'Get plan-gated feature flags — current plan tier, whether AI analysis is enabled, max pages, and whether agentic testing is available.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/plan/features');
    if (!ok) return errorResult(`Failed to get plan features: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_ai_status',
  {
    title: 'AI Status',
    description:
      'Check AI availability — local Ollama models and cloud Cortex status. Shows which AI backends are available for analysis.',
    inputSchema: z.object({}),
  },
  async (): Promise<CallToolResult> => {
    const { ok, data } = await daemonFetch('/api/ai/status');
    if (!ok) return errorResult(`Failed to get AI status: ${JSON.stringify(data)}`);
    return jsonResult(data);
  }
);

server.registerTool(
  'neuraldiff_ai_ollama_test',
  {
    title: 'Test Ollama Connection',
    description:
      'Test connectivity to a local Ollama instance. Returns available models list.',
    inputSchema: z.object({
      url: z.string().optional().describe('Ollama URL (default http://localhost:11434)'),
    }),
  },
  async ({ url }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (url) body.url = url;
    const { ok, data } = await daemonFetch('/api/ai/ollama/test', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!ok) return errorResult(`Ollama test failed: ${JSON.stringify(data)}`);
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

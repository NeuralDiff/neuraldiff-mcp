# CLAUDE.md — neuraldiff-mcp

## What This Is

MCP (Model Context Protocol) server that exposes NeuralDiff visual regression tools to AI coding assistants like Claude, Cursor, and Windsurf. When an AI assistant needs to capture screenshots, compare UI states, or analyze visual changes, it calls tools through this server.

## System Context

NeuralDiff is a multi-repo system:
- **neuraldiff-web** — Dashboard UI
- **neuraldiff-api** — Backend analysis engine
- **neuraldiff-sdk** — Client library + daemon (this MCP server connects to the daemon)
- **neuraldiff-mcp** (this repo) — MCP tool server for AI assistants
- **neuraldiff-docs** — Public documentation
- **neuraldiff-research** — Private algorithm research

Flow: AI assistant calls MCP tool → This server processes the request → Connects to SDK daemon (port 7878) → Daemon captures/analyzes → Results returned to AI assistant with opinionated verdicts.

## Tech Stack

- **Protocol**: Model Context Protocol (MCP)
- **SDK**: @modelcontextprotocol/sdk 1.12.1
- **Transport**: StdioServerTransport (stdin/stdout)
- **Validation**: Zod 3.25
- **Language**: TypeScript 5.3
- **Build**: tsc → `dist/`
- **Dev**: ts-node
- **License**: MIT

## Key Commands

```bash
npm run build    # tsc → dist/
npm run dev      # ts-node src/index.ts
npm start        # node dist/index.js
```

The binary is registered as `neuraldiff-mcp` in package.json `bin`.

## Directory Structure

```
src/
├── index.ts         # Server setup, tool registration, transport binding
├── types.ts         # TypeScript type definitions
├── escalation.ts    # Analysis escalation logic and severity mapping
└── patterns.ts      # Pattern matching definitions (layout, color, typography, etc.)
```

This is a small, focused codebase — 4 source files.

## Architecture & Patterns

### Server Setup
`src/index.ts`:
1. Creates MCP `Server` instance with server info and capabilities
2. Registers a `tools/list` handler that returns all available tool definitions
3. Registers a `tools/call` handler that dispatches to the correct tool implementation
4. Binds to `StdioServerTransport` for communication with the AI host

### Tool Registration Pattern
Each tool is defined with:
- `name`: tool identifier (e.g., `neuraldiff_capture`)
- `description`: what the tool does (shown to AI)
- `inputSchema`: Zod schema defining parameters

### Daemon Communication
All tools communicate with the SDK daemon via HTTP:
```
NEURALDIFF_DAEMON_URL (default: http://localhost:7878)
```
The daemon must be running for tools to work. If it's unreachable, tools return clear error messages.

### Severity Mapping
The server maps analysis confidence scores to human-readable severity levels for AI consumption.

### Pattern Matching
`src/patterns.ts` defines visual regression pattern types:
- Layout shift patterns
- Color change patterns
- Typography change patterns
- Spacing change patterns
- Component visibility patterns

Each pattern includes metadata that helps the AI assistant understand what kind of regression was detected.

### "Diffy" Personality
The MCP server has an opinionated character called "Diffy" that provides verdicts on visual changes. Responses include both raw data and Diffy's assessment to help AI assistants make decisions.

## Coding Conventions

- **TypeScript**: ES2022 target, NodeNext module resolution
- **Validation**: All tool inputs validated with Zod schemas — never trust raw input
- **Error handling**: Tools should always return a result (even on error) rather than throwing. The MCP protocol requires structured responses.
- **Tool naming**: Prefix with `neuraldiff_` (e.g., `neuraldiff_capture`, `neuraldiff_compare`)
- **Descriptions**: Tool descriptions should be clear enough for an AI to decide when to use them without documentation

## Environment Variables

```
NEURALDIFF_DAEMON_URL=http://localhost:7878   # SDK daemon URL
```

## Common Tasks

### Add a new MCP tool
1. Define the Zod input schema in `src/index.ts` (or extract to `src/types.ts`)
2. Add the tool definition to the `tools/list` handler
3. Add the tool implementation to the `tools/call` handler
4. The tool should call the daemon via HTTP and format the response for AI consumption

### Modify escalation logic
Edit `src/escalation.ts`. Keep the severity mapping consistent with what the API and web dashboard expect.

### Add a new pattern type
Add to `src/patterns.ts`. Include: pattern name, category, visual signature description, and typical root causes.

## Gotchas

- **StdioTransport**: This server communicates via stdin/stdout. Never use `console.log` for debugging — it will corrupt the MCP protocol stream. Use `console.error` (stderr) instead.
- **Daemon dependency**: Every tool call requires the SDK daemon to be running. The MCP server itself doesn't capture screenshots or analyze images — it delegates to the daemon.
- **Zod validation**: All inputs are validated. If you add a tool parameter, add it to the Zod schema first. Unvalidated params are silently dropped.
- **No test framework**: Tests are not configured. The MCP SDK has testing utilities — consider adding them if needed.
- **Binary entry point**: `dist/index.js` must have `#!/usr/bin/env node` shebang for the `neuraldiff-mcp` bin to work. tsconfig should preserve it.

## MCP Client Configuration

To use this server in Claude Desktop or similar:
```json
{
  "mcpServers": {
    "neuraldiff": {
      "command": "neuraldiff-mcp",
      "env": {
        "NEURALDIFF_DAEMON_URL": "http://localhost:7878"
      }
    }
  }
}
```

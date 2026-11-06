// DT.ly MCP server — fine-grained, After Effects-style editing for agents.
// A thin adapter over the shared tools in src/tools: every tool takes the project file path
// as `project`; edits are saved atomically after each call.
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import {TOOLS, type ToolContext} from '../tools/index.js';
import {VERSION} from '../version.js';

const projectArg = z.string().describe('Path to the DT.ly project .json file');
// The MCP server runs on the user's machine for a local agent: it may read and write any file.
const allowRead = () => true;
const allowWrite = () => true;

export const createMcpServer = () => {
  const server = new McpServer({name: 'dtly', title: 'DT.ly — from the creator of CustomerPro.in', version: VERSION});
  for (const def of TOOLS) {
    const inputSchema = def.project ? {project: projectArg, ...def.shape} : def.shape;
    server.registerTool(def.name, {description: def.description, inputSchema, ...(def.annotations && {annotations: def.annotations})}, async (args: Record<string, unknown>) => {
      const {project, ...input} = args as {project?: string} & Record<string, unknown>;
      // Output paths given over MCP stay relative to the server's working directory, as before.
      if (def.name === 'render_video' && typeof input.out === 'string') input.out = path.resolve(input.out);
      const ctx: ToolContext = {projectPath: path.resolve(project ?? '.'), allowRead, allowWrite};
      return def.handler(input, ctx);
    });
  }
  return server;
};

// Runs the MCP server over stdio (what `dtly mcp` and the Claude Code plugin start).
export const startMcpServer = async () => {
  await createMcpServer().connect(new StdioServerTransport());
};

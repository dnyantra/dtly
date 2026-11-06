// Shared tool interface (contracts.md §3): one source of truth for the MCP server, the desktop
// app's agent and anything else that drives DT.ly with tool calls.

export interface ToolDef<I = any> {
  name: string; // same names as the MCP tools
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema (draft 2020-12), additionalProperties:false
  handler(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  projectPath: string; // absolute path to project.json
  allowRead(absPath: string): boolean; // path guard supplied by the host
  /**
   * Optional write guard: asked for every file a tool creates other than the project file itself
   * (render_video's MP4, map_tiles' PNG, render_frame/render_sheet previews in .dtly/frames).
   * Absent = all writes allowed (the MCP adapter passes allow-all, like allowRead).
   */
  allowWrite?(absPath: string): boolean;
}

export type ToolContent = {type: 'text'; text: string} | {type: 'image'; mimeType: 'image/png'; data: string /* base64 */};
export type ToolResult = {content: ToolContent[]; isError?: boolean};

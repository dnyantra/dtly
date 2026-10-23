// Setup helpers for AI coding agents: where the DT.ly skill goes and how each agent adds the MCP server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = '@dnyantra/dtly';
const SERVER = {command: 'npx', args: ['-y', PKG, 'mcp']};

// Skill folders. ".agents/skills" is the shared Agent Skills location read by Codex, Cursor,
// Gemini CLI, GitHub Copilot and others; Claude Code reads its own skills folder.
export const skillTargets = (agent: string, project: boolean) => {
  const home = os.homedir();
  const claude = project ? path.resolve('.claude/skills') : path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'skills');
  const shared = project ? path.resolve('.agents/skills') : path.join(home, '.agents', 'skills');
  if (agent === 'claude') return [claude];
  if (['codex', 'cursor', 'gemini', 'copilot', 'agents'].includes(agent)) return [shared];
  if (agent === 'all') return [claude, shared];
  throw new Error(`Unknown agent "${agent}". Use claude, codex, cursor, gemini, copilot or all.`);
};

export const installSkill = (pkgRoot: string, dirs: string[]) =>
  dirs.map((base) => {
    const dest = path.join(base, 'dtly');
    fs.mkdirSync(dest, {recursive: true});
    fs.cpSync(path.join(pkgRoot, 'plugin/skills/dtly'), dest, {recursive: true});
    return dest;
  });

const json = (o: unknown) => JSON.stringify(o, null, 2);

// MCP setup per agent: a ready-to-run command where the agent has one, otherwise the config snippet.
export const MCP_SETUP: Record<string, {file: string; text: string}> = {
  claude: {
    file: 'Claude Code',
    text: `claude mcp add --scope user dtly -- npx -y ${PKG} mcp\n\n# or install the plugin (MCP server + skill):\n/plugin install dtly --marketplace dnyantra/dtly`,
  },
  codex: {
    file: '~/.codex/config.toml (or .codex/config.toml in a trusted project)',
    text: `codex mcp add dtly -- npx -y ${PKG} mcp\n\n# or add to the config file:\n[mcp_servers.dtly]\ncommand = "npx"\nargs = ["-y", "${PKG}", "mcp"]\n# for unattended runs (codex exec), pre-approve DT.ly's tools:\ndefault_tools_approval_mode = "approve"`,
  },
  cursor: {file: '~/.cursor/mcp.json (or .cursor/mcp.json in the project)', text: json({mcpServers: {dtly: SERVER}})},
  gemini: {file: '~/.gemini/settings.json (or .gemini/settings.json in the project)', text: json({mcpServers: {dtly: SERVER}})},
  copilot: {file: '.vscode/mcp.json (VS Code with GitHub Copilot)', text: json({servers: {dtly: {type: 'stdio', ...SERVER}}})},
  windsurf: {file: '~/.codeium/windsurf/mcp_config.json', text: json({mcpServers: {dtly: SERVER}})},
};

export const setupGuide = (agent: string) => {
  const m = MCP_SETUP[agent];
  if (!m) throw new Error(`Unknown agent "${agent}". Options: ${Object.keys(MCP_SETUP).join(', ')}`);
  const skillDir = agent === 'claude' ? '~/.claude/skills' : '~/.agents/skills';
  return [
    `DT.ly setup for ${agent}`,
    '',
    `1. Skill (motion-design guidance for the agent) → ${skillDir}/dtly`,
    `   npx ${PKG} skill install --agent ${agent}`,
    `   (or for every agent at once: npx skills add dnyantra/dtly)`,
    '',
    `2. MCP server (the editing tools) → ${m.file}`,
    ...m.text.split('\n').map((l) => (l ? `   ${l}` : '')),
    '',
    '3. Restart the agent and ask it to "list the dtly tools" to check.',
    'Needs Node.js 20+ and FFmpeg on PATH.',
  ].join('\n');
};

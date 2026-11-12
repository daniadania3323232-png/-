import fs from 'node:fs';
import path from 'node:path';
import type { ServerSpec } from './config.js';

export interface ResolvedLauncher {
  command: string;
  args: string[];
}

/**
 * Roblox Studio ships a built-in MCP server that speaks stdio through a
 * platform-specific launcher (see https://create.roblox.com/docs/studio/mcp).
 */
export function resolveRobloxStudio(): ResolvedLauncher {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('LOCALAPPDATA is not set; cannot locate Roblox Studio');
    const bat = path.join(local, 'Roblox', 'mcp.bat');
    if (!fs.existsSync(bat)) {
      throw new Error(
        `${bat} not found. Open Roblox Studio → Assistant → … → Manage MCP Servers and turn on "Enable Studio as MCP server".`,
      );
    }
    return { command: 'cmd.exe', args: ['/c', bat] };
  }
  if (process.platform === 'darwin') {
    const bin = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
    if (!fs.existsSync(bin)) {
      throw new Error(`${bin} not found. Install Roblox Studio and enable "Enable Studio as MCP server" in Assistant settings.`);
    }
    return { command: bin, args: [] };
  }
  throw new Error(`Roblox Studio is not available on ${process.platform} (Windows and macOS only)`);
}

export function resolveLauncher(name: string, spec: ServerSpec): ResolvedLauncher {
  if (spec.preset === 'roblox-studio') return resolveRobloxStudio();
  if (!spec.command) throw new Error(`Server "${name}" needs either "preset" or "command"`);
  return { command: spec.command, args: spec.args };
}

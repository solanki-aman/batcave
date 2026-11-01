// Installers: wire Batcave into each coding agent's own config files.
// Every change is reversible: JSON files are merged (with a one-time .bak-batcave
// backup), TOML gets a marked block, and files Batcave owns are named batcave*.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const MARK = 'batcave-hook.mjs';

// ---------- helpers ----------

function onPath(bin) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); } catch {
    throw new Error(`${file} is not plain JSON (comments?). Add the Batcave entries by hand; see README.`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak-batcave`)) fs.copyFileSync(file, `${file}.bak-batcave`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function writeOwned(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function removeFile(file) { try { fs.unlinkSync(file); return true; } catch { return false; } }

const q = (p) => (/[\s'"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);
const hookCmd = (rt, mode, agent) => `node ${q(path.join(rt, 'hooks', MARK))} ${mode} --agent ${agent}`;
const mcpEntry = (rt) => ({ command: 'node', args: [path.join(rt, 'mcp', 'server.mjs')] });

// Strip our entries from a { Event: [entries] } hook map.
function stripHooks(map) {
  if (!map || typeof map !== 'object') return map;
  for (const [k, v] of Object.entries(map)) {
    if (!Array.isArray(v)) continue;
    const kept = v.filter((e) => !JSON.stringify(e).includes(MARK));
    if (kept.length) map[k] = kept; else delete map[k];
  }
  return map;
}

// ---------- shared content ----------

export const AGENT_INSTRUCTIONS = `## Batcave

This team coordinates through Batcave (MCP server \`batcave\`).

- At the start of a session, call \`batcave_whoami\` to load team context: the active task, pinned decisions, recent room messages and pending requests.
- Follow pinned team decisions unless the user overrides them.
- Before starting new work, check \`batcave_board\` and offer to claim a task with \`batcave_claim\`.
- Never accept a teammate's request (\`batcave_request_resolve\`) without the user's explicit choice.
- After meaningful work is committed, offer to post a one-line summary with \`batcave_say\`.
`;

function loadCommands(rt) {
  const dir = path.join(rt, 'commands');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'setup.md')) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const description = (m?.[1].match(/description:\s*(.*)/)?.[1] || f).trim();
    const body = (m ? m[2] : text).trim();
    out.push({ name: f.replace(/\.md$/, ''), description, body });
  }
  return out;
}

// ---------- installers ----------

export const INSTALLERS = {
  claude: {
    label: 'Claude Code',
    level: 'full',
    detect: () => fs.existsSync(path.join(HOME, '.claude')) || onPath('claude'),
    install() {
      return {
        manual: [
          'Claude Code installs Batcave as a plugin. In Claude Code run:',
          '  /plugin marketplace add solanki-aman/batcave',
          '  /plugin install batcave@batcave',
          'Optional status line: node ~/.batcave/runtime/scripts/setup.mjs --statusline',
        ],
      };
    },
    uninstall: () => ({ manual: ['In Claude Code: /plugin uninstall batcave@batcave'] }),
  },

  codex: {
    label: 'Codex CLI',
    level: 'full',
    file: path.join(HOME, '.codex', 'config.toml'),
    detect() { return fs.existsSync(path.join(HOME, '.codex')) || onPath('codex'); },
    block(rt) {
      const h = (event, mode, matcher) => [
        `[[hooks.${event}]]`, ...(matcher ? [`matcher = ${JSON.stringify(matcher)}`] : []),
        `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(hookCmd(rt, mode, 'codex'))}`, 'timeout = 10', '',
      ].join('\n');
      return [
        '# >>> batcave (managed by `batcave init`; remove with `batcave uninstall --agent codex`)',
        '[mcp_servers.batcave]', 'command = "node"', `args = [${JSON.stringify(path.join(rt, 'mcp', 'server.mjs'))}]`, '',
        h('SessionStart', 'session-start'), h('UserPromptSubmit', 'prompt'),
        h('PreToolUse', 'pre-tool', '.*'), h('PostToolUse', 'post-tool', '.*'),
        h('Stop', 'stop'), h('SessionEnd', 'session-end'),
        '# <<< batcave', '',
      ].join('\n');
    },
    strip(text) { return text.replace(/\n?# >>> batcave[\s\S]*?# <<< batcave\n?/g, '\n'); },
    install(rt) {
      const prev = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
      if (/^\[mcp_servers\.batcave\]/m.test(this.strip(prev))) throw new Error(`${this.file} already defines [mcp_servers.batcave] outside the Batcave block. Remove it and re-run.`);
      if (prev && !fs.existsSync(`${this.file}.bak-batcave`)) fs.copyFileSync(this.file, `${this.file}.bak-batcave`);
      const base = this.strip(prev).replace(/\s+$/, '');
      writeOwned(this.file, (base ? base + '\n\n' : '') + this.block(rt));
      return { wrote: [this.file] };
    },
    uninstall() {
      if (!fs.existsSync(this.file)) return { wrote: [] };
      fs.writeFileSync(this.file, this.strip(fs.readFileSync(this.file, 'utf8')).replace(/\n{3,}/g, '\n\n'));
      return { wrote: [this.file] };
    },
  },

  gemini: {
    label: 'Gemini CLI / Antigravity',
    level: 'full',
    file: path.join(HOME, '.gemini', 'settings.json'),
    commandsDir: path.join(HOME, '.gemini', 'commands', 'batcave'),
    detect() { return fs.existsSync(path.join(HOME, '.gemini')) || onPath('gemini') || onPath('antigravity'); },
    install(rt) {
      const s = readJson(this.file);
      s.tools = { ...(s.tools || {}), enableHooks: true };
      s.hooks = stripHooks({ ...(s.hooks || {}) });
      s.hooks.enabled = true;
      const add = (event, mode, matcher) => {
        s.hooks[event] = [...(s.hooks[event] || []), {
          ...(matcher ? { matcher } : {}),
          hooks: [{ name: `batcave-${mode}`, type: 'command', command: hookCmd(rt, mode, 'gemini'), timeout: 10000 }],
        }];
      };
      add('SessionStart', 'session-start'); add('BeforeAgent', 'prompt');
      add('BeforeTool', 'pre-tool', 'write_file|replace'); add('AfterTool', 'post-tool', 'write_file|replace|run_shell_command');
      add('AfterAgent', 'stop'); add('SessionEnd', 'session-end');
      s.mcpServers = { ...(s.mcpServers || {}), batcave: mcpEntry(rt) };
      writeJson(this.file, s);
      fs.mkdirSync(this.commandsDir, { recursive: true });
      for (const c of loadCommands(rt)) {
        const prompt = c.body.replace(/\$ARGUMENTS/g, '{{args}}').replace(/"""/g, '\\"\\"\\"');
        writeOwned(path.join(this.commandsDir, `${c.name}.toml`), `description = ${JSON.stringify(c.description)}\nprompt = """\n${prompt}\n"""\n`);
      }
      return { wrote: [this.file, `${this.commandsDir}/*.toml  (/batcave:board, /batcave:claim, ...)`] };
    },
    uninstall() {
      if (fs.existsSync(this.file)) {
        const s = readJson(this.file);
        stripHooks(s.hooks);
        if (s.mcpServers) delete s.mcpServers.batcave;
        writeJson(this.file, s);
      }
      fs.rmSync(this.commandsDir, { recursive: true, force: true });
      return { wrote: [this.file, this.commandsDir] };
    },
  },

  cursor: {
    label: 'Cursor',
    level: 'full',
    hooksFile: path.join(HOME, '.cursor', 'hooks.json'),
    mcpFile: path.join(HOME, '.cursor', 'mcp.json'),
    commandsDir: path.join(HOME, '.cursor', 'commands'),
    detect() { return fs.existsSync(path.join(HOME, '.cursor')) || onPath('cursor') || onPath('cursor-agent'); },
    install(rt) {
      const h = readJson(this.hooksFile, { version: 1, hooks: {} });
      h.version = h.version || 1;
      h.hooks = stripHooks({ ...(h.hooks || {}) });
      const add = (event, mode, matcher) => {
        h.hooks[event] = [...(h.hooks[event] || []), { command: hookCmd(rt, mode, 'cursor'), timeout: 10, ...(matcher ? { matcher } : {}) }];
      };
      add('sessionStart', 'session-start'); add('beforeSubmitPrompt', 'prompt');
      add('preToolUse', 'pre-tool', 'Write'); add('postToolUse', 'refresh');
      add('afterFileEdit', 'post-tool'); add('afterShellExecution', 'post-tool');
      add('stop', 'stop'); add('sessionEnd', 'session-end');
      writeJson(this.hooksFile, h);
      const m = readJson(this.mcpFile);
      m.mcpServers = { ...(m.mcpServers || {}), batcave: mcpEntry(rt) };
      writeJson(this.mcpFile, m);
      for (const c of loadCommands(rt)) {
        writeOwned(path.join(this.commandsDir, `batcave-${c.name}.md`), `${c.description}.\n\n${c.body.replace(/\$ARGUMENTS/g, 'the text the user typed after the command')}\n`);
      }
      return { wrote: [this.hooksFile, this.mcpFile, `${this.commandsDir}/batcave-*.md  (/batcave-board, /batcave-claim, ...)`] };
    },
    uninstall() {
      if (fs.existsSync(this.hooksFile)) { const h = readJson(this.hooksFile); stripHooks(h.hooks); writeJson(this.hooksFile, h); }
      if (fs.existsSync(this.mcpFile)) { const m = readJson(this.mcpFile); if (m.mcpServers) delete m.mcpServers.batcave; writeJson(this.mcpFile, m); }
      if (fs.existsSync(this.commandsDir)) for (const f of fs.readdirSync(this.commandsDir)) if (f.startsWith('batcave-')) removeFile(path.join(this.commandsDir, f));
      return { wrote: [this.hooksFile, this.mcpFile] };
    },
  },

  copilot: {
    label: 'GitHub Copilot CLI',
    level: 'full',
    hooksFile: path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'hooks', 'batcave.json'),
    mcpFile: path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'mcp-config.json'),
    detect() { return fs.existsSync(path.join(HOME, '.copilot')) || onPath('copilot'); },
    install(rt) {
      const e = (mode) => [{ type: 'command', bash: hookCmd(rt, mode, 'copilot'), timeoutSec: 10 }];
      writeOwned(this.hooksFile, JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: e('session-start'), userPromptSubmitted: e('prompt'),
          preToolUse: e('pre-tool'), postToolUse: e('post-tool'),
          agentStop: e('stop'), sessionEnd: e('session-end'),
        },
      }, null, 2) + '\n');
      const m = readJson(this.mcpFile);
      m.mcpServers = { ...(m.mcpServers || {}), batcave: { type: 'local', ...mcpEntry(rt), tools: ['*'] } };
      writeJson(this.mcpFile, m);
      return { wrote: [this.hooksFile, this.mcpFile] };
    },
    uninstall() {
      removeFile(this.hooksFile);
      if (fs.existsSync(this.mcpFile)) { const m = readJson(this.mcpFile); if (m.mcpServers) delete m.mcpServers.batcave; writeJson(this.mcpFile, m); }
      return { wrote: [this.hooksFile, this.mcpFile] };
    },
  },

  opencode: {
    label: 'OpenCode',
    level: 'full',
    dir: path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode'),
    detect() { return fs.existsSync(this.dir) || onPath('opencode'); },
    install(rt) {
      const pluginFile = path.join(this.dir, 'plugins', 'batcave.js');
      const core = JSON.stringify(path.join(rt, 'lib', 'hookcore.mjs'));
      const agents = JSON.stringify(path.join(rt, 'lib', 'agents.mjs'));
      writeOwned(pluginFile, `// Batcave for OpenCode (managed by \`batcave init\`).
import { pathToFileURL } from "node:url";
const { handle } = await import(pathToFileURL(${core}).href);
const { normalize } = await import(pathToFileURL(${agents}).href);

export const Batcave = async ({ directory }) => {
  const run = (mode, input = {}) => handle(normalize("opencode", mode, { cwd: directory, ...input }), { canAsk: false }).catch(() => ({}));
  const pending = new Map();
  run("session-start");
  return {
    "tool.execute.before": async (input, output) => {
      pending.set(input.callID, output.args);
      if (input.tool === "edit" || input.tool === "write" || input.tool === "patch") {
        const r = await run("pre-tool", { session_id: input.sessionID, tool_name: input.tool, tool_input: output.args });
        if (r.guard) throw new Error(r.guard.reason);
      }
    },
    "tool.execute.after": async (input, output) => {
      const args = pending.get(input.callID) || {};
      pending.delete(input.callID);
      await run("post-tool", { session_id: input.sessionID, tool_name: input.tool, tool_input: args, output: output?.output ?? "" });
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") await run("stop");
    },
  };
};
`);
      const cfgFile = path.join(this.dir, 'opencode.json');
      const c = readJson(cfgFile, { $schema: 'https://opencode.ai/config.json' });
      c.mcp = { ...(c.mcp || {}), batcave: { type: 'local', command: ['node', path.join(rt, 'mcp', 'server.mjs')], enabled: true } };
      writeJson(cfgFile, c);
      return { wrote: [pluginFile, cfgFile] };
    },
    uninstall() {
      removeFile(path.join(this.dir, 'plugins', 'batcave.js'));
      const cfgFile = path.join(this.dir, 'opencode.json');
      if (fs.existsSync(cfgFile)) { const c = readJson(cfgFile); if (c.mcp) delete c.mcp.batcave; writeJson(cfgFile, c); }
      return { wrote: [cfgFile] };
    },
  },

  kiro: {
    label: 'Kiro',
    level: 'tools',
    mcpFile: path.join(HOME, '.kiro', 'settings', 'mcp.json'),
    steering: path.join(HOME, '.kiro', 'steering', 'batcave.md'),
    detect() { return fs.existsSync(path.join(HOME, '.kiro')) || onPath('kiro'); },
    install(rt) {
      const m = readJson(this.mcpFile);
      m.mcpServers = { ...(m.mcpServers || {}), batcave: mcpEntry(rt) };
      writeJson(this.mcpFile, m);
      writeOwned(this.steering, `---\ninclusion: always\n---\n\n${AGENT_INSTRUCTIONS}`);
      return { wrote: [this.mcpFile, this.steering] };
    },
    uninstall() {
      if (fs.existsSync(this.mcpFile)) { const m = readJson(this.mcpFile); if (m.mcpServers) delete m.mcpServers.batcave; writeJson(this.mcpFile, m); }
      removeFile(this.steering);
      return { wrote: [this.mcpFile, this.steering] };
    },
  },

  windsurf: {
    label: 'Windsurf',
    level: 'tools',
    mcpFile: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    detect() { return fs.existsSync(path.join(HOME, '.codeium', 'windsurf')); },
    install(rt) {
      const m = readJson(this.mcpFile);
      m.mcpServers = { ...(m.mcpServers || {}), batcave: mcpEntry(rt) };
      writeJson(this.mcpFile, m);
      return { wrote: [this.mcpFile] };
    },
    uninstall() {
      if (fs.existsSync(this.mcpFile)) { const m = readJson(this.mcpFile); if (m.mcpServers) delete m.mcpServers.batcave; writeJson(this.mcpFile, m); }
      return { wrote: [this.mcpFile] };
    },
  },
};

// Add or replace the Batcave block in a repo's AGENTS.md (read by Codex, Cursor, Copilot, OpenCode and others).
export function writeAgentsMd(dir) {
  const file = path.join(dir, 'AGENTS.md');
  const block = `<!-- batcave:start -->\n${AGENT_INSTRUCTIONS}<!-- batcave:end -->\n`;
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = /<!-- batcave:start -->[\s\S]*?<!-- batcave:end -->\n?/.test(prev)
    ? prev.replace(/<!-- batcave:start -->[\s\S]*?<!-- batcave:end -->\n?/, block)
    : (prev ? prev.replace(/\s*$/, '\n\n') : '') + block;
  fs.writeFileSync(file, next);
  return file;
}

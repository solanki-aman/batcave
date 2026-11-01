// Per-agent adapters: turn each agent's hook payload into a normalized event,
// and turn Batcave's result back into the output that agent understands.

const EDIT_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', // Claude Code, Codex, OpenCode
  'apply_patch', 'patch',                       // Codex, OpenCode
  'write_file', 'replace',                      // Gemini CLI / Antigravity
  'create', 'str_replace_editor',               // Copilot CLI
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'run_shell_command', 'powershell']);

function parseMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function collectStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

function filesFrom(input, args) {
  const files = [];
  for (const src of [args, input]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'absolute_path']) {
      if (typeof src[k] === 'string' && src[k]) files.push(src[k]);
    }
  }
  // apply_patch style: "*** Update File: src/a.ts"
  for (const s of collectStrings(args)) {
    for (const m of s.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(m[1].trim());
  }
  return [...new Set(files)];
}

function commandFrom(input, args) {
  const c = (args && typeof args === 'object' ? args.command ?? args.cmd : undefined) ?? input.command;
  if (Array.isArray(c)) return c.join(' ');
  return typeof c === 'string' ? c : '';
}

export function normalize(agent, mode, input = {}) {
  const toolName = String(input.tool_name ?? input.toolName ?? input.tool ?? '');
  const args = parseMaybe(input.tool_input ?? input.toolArgs ?? input.args ?? {});
  const files = filesFrom(input, args);
  const command = commandFrom(input, args);
  const lower = toolName.toLowerCase();
  let tool = EDIT_TOOLS.has(lower) ? 'edit' : SHELL_TOOLS.has(lower) ? 'shell' : 'other';
  if (tool === 'other' && !toolName) tool = files.length ? 'edit' : command ? 'shell' : 'other'; // Cursor afterFileEdit / afterShellExecution
  const output = input.tool_response ?? input.toolResult ?? input.tool_result ?? input.output ?? input.result ?? '';
  return {
    kind: mode,
    agent,
    cwd: input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || process.env.GEMINI_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    sessionId: input.session_id ?? input.sessionId ?? input.conversation_id ?? input.sessionID ?? `${agent}-default`,
    toolName, tool, files, command,
    output: typeof output === 'string' ? output : JSON.stringify(output),
  };
}

const claudeStyle = {
  canAsk: true,
  format(mode, r) {
    const event = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' }[mode];
    if (r.context && event && mode !== 'pre-tool') return { hookSpecificOutput: { hookEventName: event, additionalContext: r.context } };
    if (r.guard && mode === 'pre-tool') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.guard.reason } };
    return null;
  },
};

export const ADAPTERS = {
  claude: { ...claudeStyle, label: 'Claude Code' },
  codex: { ...claudeStyle, label: 'Codex' },

  gemini: {
    label: 'Gemini CLI',
    canAsk: false,
    format(mode, r) {
      const event = { 'session-start': 'SessionStart', prompt: 'BeforeAgent' }[mode];
      if (r.context && event) return { hookSpecificOutput: { hookEventName: event, additionalContext: r.context } };
      if (r.guard && mode === 'pre-tool') return { decision: 'deny', reason: r.guard.reason };
      return null;
    },
  },

  cursor: {
    label: 'Cursor',
    canAsk: false,
    format(mode, r) {
      if (mode === 'prompt') return { continue: true };
      if (r.context && (mode === 'session-start' || mode === 'refresh')) return { additional_context: r.context };
      if (r.guard && mode === 'pre-tool') return { permission: 'deny', user_message: r.guard.reason, agent_message: r.guard.reason };
      if (mode === 'pre-tool') return { permission: 'allow' };
      return null;
    },
  },

  copilot: {
    label: 'Copilot CLI',
    canAsk: true,
    refreshOnPostTool: true,
    format(mode, r) {
      if (r.context && (mode === 'session-start' || mode === 'post-tool')) return { additionalContext: r.context };
      if (r.guard && mode === 'pre-tool') return { permissionDecision: 'ask', permissionDecisionReason: r.guard.reason };
      return null;
    },
  },

  // OpenCode runs Batcave in-process (see installers), so it needs no output format.
  opencode: { label: 'OpenCode', canAsk: false, format: () => null },
};
ADAPTERS.antigravity = { ...ADAPTERS.gemini, label: 'Antigravity' };

export function adapterFor(agent) {
  return ADAPTERS[agent] || ADAPTERS.claude;
}

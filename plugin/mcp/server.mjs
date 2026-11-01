#!/usr/bin/env node
// Batcave MCP server (stdio, zero dependencies). Works with any MCP-capable coding agent.
import readline from 'node:readline';
import { tools } from '../lib/tools.mjs';

const VERSION = '0.2.0';

// ---------- JSON-RPC over stdio ----------

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'batcave', version: VERSION },
      instructions: 'Batcave connects this coding-agent session to the user\'s team: board, people, rooms, decisions, requests, handoffs. At the start of a session call batcave_whoami for team context. Never accept a request on the user\'s behalf without their explicit choice.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: Object.entries(tools).map(([name, t]) => ({
        name, description: t.description,
        inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}) },
      })),
    });
  }
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const text = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `Batcave error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((err) => msg.id != null && fail(msg.id, -32603, err.message));
});

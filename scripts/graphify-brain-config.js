#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

const [command, ...args] = process.argv.slice(2);
const path = args[0];

function failValidation(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (command === 'config-path') {
  try {
    const config = readJson(path);
    if (!Object.hasOwn(config, 'graphifyBrainPath')) {
      process.exit(0);
    }
    const value = config.graphifyBrainPath;
    if (typeof value === 'string' && value.trim()) {
      process.stdout.write(value.trim());
    } else {
      throw new Error('graphifyBrainPath must be a non-empty string');
    }
  } catch {
    process.exitCode = 1;
  }
} else if (command === 'validate-graph') {
  try {
    const graph = readJson(path);
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      throw new Error('graph.json must contain nodes and links arrays');
    }
    process.stdout.write(JSON.stringify({
      nodes: graph.nodes.length,
      edges: graph.links.length,
      hyperedges: Array.isArray(graph.hyperedges) ? graph.hyperedges.length : 0,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else if (command === 'validate-codex-mcp') {
  try {
    const [expectedCommand, expectedGraph] = args;
    const mcp = JSON.parse(fs.readFileSync(0, 'utf8'));
    const transport = mcp.transport;
    if (mcp.name !== 'graphify-brain' || mcp.enabled !== true) {
      throw new Error('Codex MCP must be graphify-brain and enabled');
    }
    if (!transport || transport.type !== 'stdio' || transport.command !== expectedCommand) {
      throw new Error('Codex MCP must use the exact stdio command');
    }
    if (!Array.isArray(transport.args)
      || transport.args.length !== 2
      || transport.args[0] !== '--graph'
      || transport.args[1] !== expectedGraph) {
      throw new Error('Codex MCP must use the exact canonical graph argument');
    }
  } catch (error) {
    failValidation(error.message);
  }
} else if (command === 'validate-claude-mcp') {
  try {
    const [expectedCommand, expectedGraph] = args;
    const lines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    if (!lines.includes('graphify-brain:')) {
      throw new Error('Claude MCP output is missing the graphify-brain header');
    }
    const fields = new Map();
    for (const line of lines) {
      const match = line.match(/^\s{2}(Status|Type|Command|Args):\s*(.*)$/);
      if (!match) continue;
      if (fields.has(match[1])) throw new Error(`Claude MCP repeats ${match[1]}`);
      fields.set(match[1], match[2]);
    }
    if (!/^[^A-Za-z0-9]*Connected$/.test(fields.get('Status') || '')) {
      throw new Error('Claude MCP is not connected');
    }
    if (fields.get('Type') !== 'stdio' || fields.get('Command') !== expectedCommand) {
      throw new Error('Claude MCP must use the exact stdio command');
    }
    if (fields.get('Args') !== `--graph ${expectedGraph}`) {
      throw new Error('Claude MCP must use the exact canonical graph argument');
    }
  } catch (error) {
    failValidation(error.message);
  }
} else if (command === 'probe-mcp') {
  // `graphify-mcp --help` is a VACUOUS probe: it parses arguments and exits 0
  // without ever building the server, so it returned success while the server
  // died in _build_server with `ImportError: cannot import name 'AnyUrl' from
  // 'mcp.types'` — measured against mcp 2.0.0. The only check that separates a
  // launcher that starts from a server that serves is speaking the protocol,
  // so this drives a real stdio handshake and requires a JSON-RPC result.
  const { spawn } = require('node:child_process');
  const [bin, graph] = args;
  const timeoutMs = Number(process.env.GRAPHIFY_MCP_PROBE_TIMEOUT_MS || 15000);

  if (!bin || !graph) {
    process.stderr.write('probe-mcp requires <graphify-mcp-bin> <graph-path>\n');
    process.exit(2);
  }

  const child = spawn(bin, ['--graph', graph], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;

  const finish = (code, message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (message) process.stderr.write(`${message}\n`);
    // SIGKILL, not the default SIGTERM: a server wedged in its own startup may
    // not run handlers, and this probe must not outlive its own timeout.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(code);
  };

  const timer = setTimeout(
    () => finish(1, `graphify-mcp did not answer initialize within ${timeoutMs}ms${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`),
    timeoutMs,
  );

  child.on('error', (error) => finish(1, `graphify-mcp could not be started: ${error.message}`));
  // A server that dies before answering must not leave the probe waiting out
  // the full timeout — report the crash with the line that explains it.
  //
  // 'close', NOT 'exit': 'exit' fires as soon as the process is gone, while
  // its stdout may still hold an unread answer, so a server that replies and
  // then exits would race and be reported as a crash. 'close' waits for both
  // stdio streams, and the stdout handler below settles first when there is
  // an answer to settle on.
  child.on('close', () => finish(1, `graphify-mcp exited before answering initialize${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    // Frames are newline-delimited; the trailing partial stays buffered.
    const lines = stdout.split('\n');
    stdout = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id !== 1) continue;
      if (frame.result) finish(0, null);
      else finish(1, `graphify-mcp rejected initialize: ${JSON.stringify(frame.error)}`);
    }
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'jarvis-doctor', version: '1' },
    },
  })}\n`);
} else {
  process.stderr.write('Usage: graphify-brain-config.js <config-path|validate-graph|validate-codex-mcp|validate-claude-mcp|probe-mcp> [args]\n');
  process.exitCode = 2;
}

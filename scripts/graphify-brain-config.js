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
} else {
  process.stderr.write('Usage: graphify-brain-config.js <config-path|validate-graph|validate-codex-mcp|validate-claude-mcp> [args]\n');
  process.exitCode = 2;
}

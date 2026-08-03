#!/usr/bin/env node
/**
 * JARVIS Instinct System — Stop Hook
 *
 * Reads session transcript, extracts relevant action→response pairs,
 * tool errors, and skills used. Appends structured summary to memory/inbox.md.
 *
 * Does NOT interpret patterns — that's Claude's job at next boot.
 */

const path = require('path');
const fs = require('fs');
const {
  readStdinJson,
  getClaudeDir,
  ensureDir,
  appendFile,
  log
} = require('../strategic-compact/lib/utils');

const MIN_USER_MESSAGES = 10;
const SHORT_MESSAGE_THRESHOLD = 20;

/**
 * Parse transcript JSONL file into structured turns
 */
function parseTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return [];

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const turns = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        turns.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return turns;
}

/**
 * Extract user text from a user message entry
 */
function getUserText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    if (content.includes('local-command-caveat')) return null;
    return content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter(b => b.type === 'text' && !b.text?.includes('local-command-caveat'))
      .map(b => b.text);
    return textBlocks.join('\n') || null;
  }
  return null;
}

/**
 * Extract assistant actions from an assistant message entry
 */
function getAssistantActions(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return { text: '', toolCalls: [], skills: [] };

  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const toolCalls = content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name, input: b.input }));
  const skills = toolCalls
    .filter(tc => tc.name === 'Skill')
    .map(tc => tc.input?.skill)
    .filter(Boolean);

  return { text, toolCalls, skills };
}

/**
 * Check if a user message in a tool_result contains an error
 */
function getToolErrors(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_result' && b.is_error)
    .map(b => ({ tool_use_id: b.tool_use_id }));
}

/**
 * Build inbox entry from parsed transcript data
 */
function buildInboxEntry(sessionId, turns, pairs, toolErrors, allSkills) {
  const date = new Date().toISOString();
  const lines = [];

  lines.push(`## Session ${sessionId} — ${date} — ${turns.length} turns`);
  lines.push('');

  if (pairs.length > 0) {
    lines.push('### Pares ação→resposta relevantes');
    lines.push('');
    for (const pair of pairs) {
      lines.push(`**[Turn ${pair.turnIndex}]** ${pair.action}`);
      lines.push(`→ Usuário: "${pair.response}"`);
      lines.push('');
    }
  }

  if (toolErrors.length > 0) {
    lines.push('### Tool errors');
    for (const err of toolErrors) {
      lines.push(`- ${err.tool}: ${err.error} (x${err.count})`);
    }
    lines.push('');
  }

  if (allSkills.length > 0) {
    lines.push('### Skills usadas');
    lines.push(allSkills.join(' → '));
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const data = await readStdinJson({ timeoutMs: 30000 });
  const transcriptPath = data.transcript_path || '';
  const sessionId = data.session_id || 'unknown';

  if (!transcriptPath) {
    log('[Instinct] No transcript path — skipping');
    process.exit(0);
  }

  const turns = parseTranscript(transcriptPath);
  const userTurns = turns.filter(t => t.type === 'user');

  if (userTurns.length < MIN_USER_MESSAGES) {
    log(`[Instinct] Short session (${userTurns.length} user msgs) — skipping`);
    process.exit(0);
  }

  // Build tool_use_id → tool_name map from assistant messages
  const toolNameMap = new Map();
  for (const turn of turns) {
    if (turn.type === 'assistant' && Array.isArray(turn.message?.content)) {
      for (const block of turn.message.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  // Extract action→response pairs
  const pairs = [];
  const allSkills = [];
  const errorMap = new Map();

  for (let i = 0; i < turns.length - 1; i++) {
    const current = turns[i];
    const next = turns[i + 1];

    // Assistant followed by user
    if (current.type === 'assistant' && next.type === 'user') {
      const actions = getAssistantActions(current);
      const userText = getUserText(next);

      // Collect skills
      allSkills.push(...actions.skills);

      // Skip short/empty responses
      if (!userText || userText.length < SHORT_MESSAGE_THRESHOLD) continue;

      // Build action summary
      let actionSummary = '';
      if (actions.toolCalls.length > 0) {
        const toolNames = actions.toolCalls.map(tc => tc.name).join(', ');
        actionSummary = `JARVIS usou ${toolNames}`;
      } else if (actions.text) {
        actionSummary = `JARVIS respondeu: "${actions.text.substring(0, 100)}..."`;
      } else {
        continue;
      }

      pairs.push({
        turnIndex: i,
        action: actionSummary,
        response: userText.substring(0, 300)
      });
    }

    // Collect tool errors from user messages (tool_result with is_error)
    if (current.type === 'user') {
      const errors = getToolErrors(current);
      for (const err of errors) {
        const key = err.tool_use_id;
        const toolName = toolNameMap.get(key) || 'unknown_tool';
        if (errorMap.has(toolName)) {
          errorMap.get(toolName).count++;
        } else {
          errorMap.set(toolName, { tool: toolName, error: 'tool error', count: 1 });
        }
      }
    }
  }

  // Deduplicate skills
  const uniqueSkills = [...new Set(allSkills)];

  // Convert error map to array
  const toolErrors = Array.from(errorMap.values());

  if (pairs.length === 0 && toolErrors.length === 0 && uniqueSkills.length === 0) {
    log('[Instinct] No relevant patterns found — skipping');
    process.exit(0);
  }

  const inboxEntry = buildInboxEntry(sessionId, turns, pairs, toolErrors, uniqueSkills);
  const inboxPath = path.join(getClaudeDir(), 'memory', 'inbox.md');
  ensureDir(path.dirname(inboxPath));
  appendFile(inboxPath, inboxEntry + '\n');

  log(`[Instinct] Session digest saved to inbox (${pairs.length} pairs, ${toolErrors.length} errors, ${uniqueSkills.length} skills)`);
  process.exit(0);
}

main().catch(err => {
  log(`[Instinct] Error: ${err.message}`);
  process.exit(0);
});

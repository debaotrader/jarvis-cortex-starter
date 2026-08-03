#!/usr/bin/env node
/**
 * Learn scanner — extracts user correction candidates from session JSONLs.
 *
 * Reads session JSONLs only after explicit approval, filters user turns matching
 * correction signal patterns (PT/EN), clusters by normalized text hash, and
 * emits JSON for the /learn skill to present for approval.
 *
 * Usage:
 *   node scan.js --allow-private-session-scan [--days N] [--project NAME]
 *   node scan.js --projects-dir PATH [--days N]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getClaudeDir } = require('../strategic-compact/lib/utils');

const DEFAULT_PROJECTS_DIR = path.join(getClaudeDir(), 'projects');

const CORRECTION_PATTERNS = [
  /\b(n[aã]o)\s+(fa[cç]a|fa[cç]|use|usa|cria|crie|quero|precisa|devia|pode)/i,
  /\b(pare|para)\s+(de|com)\b/i,
  /\bchega\s+(de|disso)\b/i,
  /\b(corrige|corrija|conserta|conserte|errou|errado|incorreto|erro meu)/i,
  /\b(nunca|sempre)\s+(fa[cç]a|fa[cç]|use|usa|cria|crie)/i,
  /\b(don['']?t|do not)\s+\w+/i,
  /\b(stop|never|always)\s+(doing|using|writing|making|creating)/i,
  /\b(wrong|incorrect|that['']?s wrong)\b/i,
  /\bplease\s+(don['']?t|stop|fix|correct)/i
];

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function hashCluster(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 8);
}

/**
 * Redact common secret patterns from text. Applied to all session
 * content that flows into jarvis-learn output (and eventually into
 * LLM context). The pattern set covers provider keys, cloud keys,
 * private-key blocks, and PT/EN credential keywords. Any future
 * secret format we forget about will silently leak, so this list
 * should be reviewed whenever a new provider is added.
 *
 * Round 6 (hm-security audit D12-F4) expansion: added GitHub PATs
 * (gh[pousr]_), Slack tokens (xox[bpa]-), AWS (AKIA[0-9A-Z]{16}),
 * Supabase (sbp_), Stripe live keys (sk_live_, pk_live_), full
 * private-key blocks, and Portuguese keywords (senha, chave, etc.).
 */
function redactSensitive(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Private-key blocks (PEM) — strip the entire block including
    // newlines. Covers RSA, EC, OPENSSH, DSA, PGP (with or without
    // the "BLOCK" suffix in newer GnuPG output), and any other PEM
    // that ends in "PRIVATE KEY" / "PRIVATE KEY BLOCK".
    .replace(/-----BEGIN [A-Z ]+(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----[\s\S]*?-----END [A-Z ]+(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----/g, '[REDACTED-PRIVATE-KEY]')
    // GitHub PATs (classic + fine-grained + server + user)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    // Slack tokens
    .replace(/\bxox[bp]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\bxoxa-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    // AWS access keys: AKIA (long-term) + ASIA (STS temporary, 1h TTL).
    // Both 16 uppercase alnum chars after the prefix.
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    // Supabase
    .replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    // Stripe live keys (do NOT redact _test_ keys — those are throwaway)
    .replace(/\bsk_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\brk_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bpk_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    // Generic sk- keys (catches MiniMax, Anthropic, OpenAI). Kept
    // the broad pattern from before; works for any 16+ char suffix.
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    // Authorization header bearer
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/ig, '$1[REDACTED]')
    // English credential keywords: token / api_key / password / secret
    .replace(/\b(token|api[_-]?key|password|secret)\s*[:=]\s*["']?[^"'\s]+/ig, '$1=[REDACTED]')
    // Portuguese credential keywords: senha / chave / token de acesso.
    // Require `:` or `=` separator (not optional) to avoid false
    // positives like natural PT sentences mentioning "token de acesso
    // expirou" (no value follows).
    .replace(/\b(senha|chave|token\s+de\s+acesso)\s*[:=]\s*["']?[^"'\s]{6,}/gi, '$1=[REDACTED]');
}

function extractUserText(entry) {
  if (!entry || entry.type !== 'user') return null;
  if (entry.userType && entry.userType !== 'external') return null;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(b => !b || b.type === 'text' || b.type === undefined)
      .map(b => (b && b.text) || '')
      .filter(t => t && !t.trim().startsWith('<'));
    return texts.join(' ');
  }
  return null;
}

function isCorrection(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.length > 500) return false;
  if (trimmed.startsWith('<')) return false;
  return CORRECTION_PATTERNS.some(p => p.test(trimmed));
}

function scanFile(filePath, cutoffMs) {
  const results = [];
  let prevAssistant = null;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return results;
  }
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (cutoffMs && entry.timestamp) {
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t) && t < cutoffMs) continue;
    }
    if (entry.type === 'assistant' && entry.message?.content) {
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
      const text = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ');
      if (text.trim()) prevAssistant = redactSensitive(text.trim()).slice(0, 300);
    }
    const userText = extractUserText(entry);
    if (userText && isCorrection(userText)) {
      results.push({
        session: path.basename(filePath, '.jsonl'),
        project: path.basename(path.dirname(filePath)),
        timestamp: entry.timestamp || null,
        text: redactSensitive(userText).slice(0, 500),
        context: prevAssistant
      });
    }
  }
  return results;
}

function scan(options = {}) {
  const {
    days = 7,
    project = null,
    projectsDir = DEFAULT_PROJECTS_DIR,
    allowPrivateSessionScan = false
  } = options;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const allCandidates = [];
  let sessionsScanned = 0;

  const isDefaultPrivateDir = path.resolve(projectsDir) === path.resolve(DEFAULT_PROJECTS_DIR);
  if (isDefaultPrivateDir && !allowPrivateSessionScan) {
    return {
      summary: {
        sessions_scanned: 0,
        candidates_found: 0,
        clusters: 0,
        privacy_blocked: true,
        reason: 'explicit approval required to scan private session transcripts'
      },
      clusters: []
    };
  }

  if (!fs.existsSync(projectsDir)) {
    return { summary: { sessions_scanned: 0, candidates_found: 0, clusters: 0 }, clusters: [] };
  }

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => !project || d.name.includes(project))
      .map(d => path.join(projectsDir, d.name));
  } catch {
    return { summary: { sessions_scanned: 0, candidates_found: 0, clusters: 0 }, clusters: [] };
  }

  for (const projDir of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }
    for (const file of files) {
      const full = path.join(projDir, file);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoffMs) continue;
      sessionsScanned++;
      allCandidates.push(...scanFile(full, cutoffMs));
    }
  }

  const clusters = new Map();
  for (const c of allCandidates) {
    const h = hashCluster(c.text);
    if (!clusters.has(h)) clusters.set(h, { hash: h, count: 0, occurrences: [] });
    const cluster = clusters.get(h);
    cluster.count++;
    cluster.occurrences.push(c);
  }

  const sorted = Array.from(clusters.values()).sort((a, b) => b.count - a.count);

  return {
    summary: {
      sessions_scanned: sessionsScanned,
      candidates_found: allCandidates.length,
      clusters: sorted.length
    },
    clusters: sorted
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const days = parseInt(getArg('--days') || '7', 10);
  const project = getArg('--project');
  const projectsDir = getArg('--projects-dir') || undefined;
  const allowPrivateSessionScan =
    args.includes('--allow-private-session-scan') ||
    process.env.JARVIS_LEARN_SCAN_APPROVED === '1';
  const result = scan({ days, project, projectsDir, allowPrivateSessionScan });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  scan,
  scanFile,
  isCorrection,
  extractUserText,
  hashCluster,
  redactSensitive,
  CORRECTION_PATTERNS
};

#!/usr/bin/env node
/**
 * Smoke + correctness tests for jarvis-learn/scan.js
 * Run: node --test active/skills/jarvis-learn/scan.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scan, isCorrection, extractUserText, hashCluster, redactSensitive } = require('./scan');

const TMP = path.join(os.tmpdir(), `learn-scan-test-${process.pid}`);
const PROJ = path.join(TMP, 'test-project');

function writeSession(name, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(PROJ, `${name}.jsonl`), lines);
}

before(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(PROJ, { recursive: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('[smoke] missing projects dir returns empty', () => {
  const r = scan({ projectsDir: '/nonexistent/path' });
  assert.strictEqual(r.summary.candidates_found, 0);
  assert.strictEqual(r.clusters.length, 0);
});

test('[privacy] default private projects dir requires explicit approval', () => {
  const r = scan();
  assert.strictEqual(r.summary.privacy_blocked, true);
  assert.strictEqual(r.summary.candidates_found, 0);
  assert.strictEqual(r.clusters.length, 0);
});

test('[smoke] malformed JSONL lines are skipped', () => {
  writeSession('malformed', [
    { type: 'user', userType: 'external', message: { content: 'não faça isso de novo' }, timestamp: new Date().toISOString() }
  ]);
  const file = path.join(PROJ, 'malformed.jsonl');
  fs.appendFileSync(file, '\nnot json at all\n{broken');
  const r = scan({ projectsDir: TMP, days: 365 });
  assert.ok(r.summary.candidates_found >= 1, 'should still find valid entries');
});

test('[correctness] isCorrection detects PT signals', () => {
  assert.ok(isCorrection('não faça isso, use a outra skill'));
  assert.ok(isCorrection('para de criar docs sem pedir'));
  assert.ok(isCorrection('corrige isso, tá errado'));
  assert.ok(isCorrection('chega de band-aids, vai na raiz'));
});

test('[correctness] isCorrection detects EN signals', () => {
  assert.ok(isCorrection("don't do that again"));
  assert.ok(isCorrection('stop doing that, please'));
  assert.ok(isCorrection('that is wrong'));
});

test('[correctness] isCorrection rejects non-corrections', () => {
  assert.ok(!isCorrection('ok vamos seguir'));
  assert.ok(!isCorrection('obrigado'));
  assert.ok(!isCorrection('<system-reminder>foo</system-reminder>'));
  assert.ok(!isCorrection(''));
  assert.ok(!isCorrection('a'.repeat(600)));
});

test('[correctness] extractUserText skips system reminders', () => {
  const entry = {
    type: 'user',
    userType: 'external',
    message: { content: [
      { type: 'text', text: '<system-reminder>ignored</system-reminder>' },
      { type: 'text', text: 'não faça isso' }
    ]}
  };
  const text = extractUserText(entry);
  assert.match(text, /não faça/);
  assert.doesNotMatch(text, /system-reminder/);
});

test('[correctness] scan detects candidate and clusters', () => {
  writeSession('s1', [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'criando README.md' }] }, timestamp: new Date().toISOString() },
    { type: 'user', userType: 'external', message: { content: 'não crie docs sem pedir' }, timestamp: new Date().toISOString() }
  ]);
  writeSession('s2', [
    { type: 'user', userType: 'external', message: { content: 'não crie docs sem pedir' }, timestamp: new Date().toISOString() }
  ]);
  const r = scan({ projectsDir: TMP, days: 365 });
  const cluster = r.clusters.find(c => c.count >= 2);
  assert.ok(cluster, 'should cluster identical corrections');
  assert.strictEqual(cluster.count, 2);
});

test('[correctness] scan captures assistant context', () => {
  writeSession('ctx', [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'criando arquivo X' }] }, timestamp: new Date().toISOString() },
    { type: 'user', userType: 'external', message: { content: 'não crie isso, para' }, timestamp: new Date().toISOString() }
  ]);
  const r = scan({ projectsDir: TMP, days: 365 });
  const hit = r.clusters.flatMap(c => c.occurrences).find(o => /não crie isso/.test(o.text));
  assert.ok(hit);
  assert.match(hit.context, /criando arquivo X/);
});

test('[privacy] scan redacts common secret patterns from output', () => {
  writeSession('secret', [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'using token=abc123' }] }, timestamp: new Date().toISOString() },
    { type: 'user', userType: 'external', message: { content: 'não use authorization: Bearer live-secret-token de novo' }, timestamp: new Date().toISOString() }
  ]);
  const r = scan({ projectsDir: TMP, days: 365 });
  const hit = r.clusters.flatMap(c => c.occurrences).find(o => /authorization/i.test(o.text));
  assert.ok(hit);
  assert.match(hit.text, /\[REDACTED\]/);
  assert.doesNotMatch(hit.text, /live-secret-token/);
  assert.match(hit.context, /token=\[REDACTED\]/);
  assert.doesNotMatch(hit.context, /abc123/);
});

test('[correctness] scan respects --days cutoff', () => {
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  writeSession('old', [
    { type: 'user', userType: 'external', message: { content: 'não faça isso antigo' }, timestamp: oldDate }
  ]);
  const file = path.join(PROJ, 'old.jsonl');
  fs.utimesSync(file, new Date(oldDate), new Date(oldDate));
  const r = scan({ projectsDir: TMP, days: 7 });
  const hit = r.clusters.flatMap(c => c.occurrences).find(o => /antigo/.test(o.text));
  assert.strictEqual(hit, undefined, 'old session should be filtered');
});

test('[correctness] hashCluster normalizes whitespace and case', () => {
  const h1 = hashCluster('Não Faça   isso agora');
  const h2 = hashCluster('NÃO FAÇA ISSO AGORA');
  assert.strictEqual(h1, h2);
});

test('[privacy] redactSensitive redacts API keys and credentials', () => {
  assert.strictEqual(redactSensitive('token=abc123'), 'token=[REDACTED]');
  assert.strictEqual(redactSensitive('api_key: xyz'), 'api_key=[REDACTED]');
  assert.strictEqual(redactSensitive('sk-1234567890abcdef'), '[REDACTED]');
});

test('[privacy] redactSensitive round 6 — expanded secret coverage', () => {
  // GitHub PATs (classic, server, user, fine-grained)
  assert.match(redactSensitive('token ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), /\[REDACTED\]/);
  assert.match(redactSensitive('gho_' + '9z8y7x6w5v4u3t2s1r0qponmlkjihgfedcba'), /\[REDACTED\]/);
  assert.match(redactSensitive('github_pat_' + '11ABCDEFG0_xyz123abc456def789ghi'), /\[REDACTED\]/);

  // Slack tokens
  assert.match(redactSensitive('xoxb' + '-1234567890-1234567890-abcdefghijklmnopqrstuvwx'), /\[REDACTED\]/);
  assert.match(redactSensitive('xoxp' + '-1234-5678-9012-3456-789012345678-abcdef1234567890abcdef1234567890'), /\[REDACTED\]/);
  assert.match(redactSensitive('xapp' + '-1-A012345-12345-abcdef1234567890abcdef1234567890'), /\[REDACTED\]/);

  // AWS access keys
  assert.match(redactSensitive('AKIA' + 'IOSFODNN7EXAMPLE'), /\[REDACTED\]/);

  // Stripe live keys
  assert.match(redactSensitive('sk_' + 'live_abcdef1234567890abcdef12345678'), /\[REDACTED\]/);
  assert.match(redactSensitive('pk_' + 'live_abcdef1234567890abcdef12345678'), /\[REDACTED\]/);

  // Supabase
  assert.match(redactSensitive('sbp_' + 'abcdef1234567890abcdef12345678'), /\[REDACTED\]/);

  // Private key blocks
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  const redacted = redactSensitive(pem);
  assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEA/);
  assert.match(redacted, /\[REDACTED-PRIVATE-KEY\]/);

  // PGP block (newer GnuPG format includes "BLOCK" suffix)
  const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQHYB...lots of base64...\n-----END PGP PRIVATE KEY BLOCK-----';
  const pgpRedacted = redactSensitive(pgp);
  assert.doesNotMatch(pgpRedacted, /lQHYB/);
  assert.match(pgpRedacted, /\[REDACTED-PRIVATE-KEY\]/);

  // AWS STS temporary keys (ASIA prefix, 1h TTL)
  assert.match(redactSensitive('ASIAI44QH8DHBEXAMPLE'), /\[REDACTED\]/);

  // Portuguese credentials
  assert.match(redactSensitive('senha: minhasenha123'), /\[REDACTED\]/);
  assert.match(redactSensitive('chave = abc-def-123'), /\[REDACTED\]/);
  assert.match(redactSensitive('token de acesso: bearer-xyz'), /\[REDACTED\]/);

  // L1 (round 6 reviewer): natural PT sentence without value
  // should NOT be redacted. Without the `[:=]` separator requirement
  // (now mandatory), "token de acesso expirou" would be redacted
  // and the next 6+ chars would be the value (here "expirou" → 7
  // chars). The fix makes separator required, so this sentence
  // passes through.
  assert.doesNotMatch(redactSensitive('o token de acesso expirou ontem'), /\[REDACTED\]/);
});

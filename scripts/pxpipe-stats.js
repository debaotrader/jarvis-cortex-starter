#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

const raw = process.argv[2];
const eventsFile = process.argv[3];

if (!raw) {
  console.error('pxpipe returned no stats payload.');
  process.exit(1);
}

let stats;
try {
  stats = JSON.parse(raw);
} catch {
  console.error('pxpipe returned invalid stats JSON.');
  process.exit(1);
}

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round1 = (value) => Math.round(value * 10) / 10;

function aggregateHistory(file, pricing) {
  if (!file || !fs.existsSync(file)) return null;

  const totals = {
    events: 0,
    successful: 0,
    compressed: 0,
    measured: 0,
    baselineInput: 0,
    savedInput: 0,
    allCounterfactual: 0,
  };

  const cacheWrite = number(pricing.cache_write_5m_multiplier) || 1.25;
  const cacheRead = number(pricing.cache_read_multiplier) || 0.1;
  const outputMultiplier = number(pricing.output_multiplier) || 5;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    totals.events += 1;
    if (number(event.status) >= 200 && number(event.status) < 300) totals.successful += 1;
    if (event.compressed === true) totals.compressed += 1;

    const hasUsage = Number.isFinite(Number(event.input_tokens)) ||
      Number.isFinite(Number(event.cache_create_tokens)) ||
      Number.isFinite(Number(event.cache_read_tokens));
    if (!hasUsage) continue;

    const actualInput = number(event.input_tokens) +
      number(event.cache_create_tokens) * cacheWrite +
      number(event.cache_read_tokens) * cacheRead;
    const output = number(event.output_tokens) * outputMultiplier;

    if (Number.isFinite(Number(event.baseline_tokens))) {
      const baselineRaw = number(event.baseline_tokens);
      const baselineCacheable = Math.min(baselineRaw, number(event.baseline_cacheable_tokens));
      const baselineInput = baselineCacheable * cacheWrite + (baselineRaw - baselineCacheable);
      totals.measured += 1;
      totals.baselineInput += baselineInput;
      totals.savedInput += baselineInput - actualInput;
      totals.allCounterfactual += baselineInput + output;
    } else {
      totals.allCounterfactual += actualInput + output;
    }
  }

  return totals.measured > 0 ? totals : null;
}

const pricing = stats.pricing_assumptions || {};
const history = aggregateHistory(eventsFile, pricing);

if (history) {
  const inputPct = history.baselineInput > 0
    ? (history.savedInput / history.baselineInput) * 100
    : 0;
  const totalPct = history.allCounterfactual > 0
    ? (history.savedInput / history.allCounterfactual) * 100
    : 0;
  const inputPerMtok = number(pricing.input_per_mtok) || 10;

  console.log('pxpipe stats (history)');
  console.log(`events: ${history.events.toLocaleString('en-US')}`);
  console.log(`successful: ${history.successful.toLocaleString('en-US')}`);
  console.log(`compressed: ${history.compressed.toLocaleString('en-US')}`);
  console.log(`saved input tokens: ${Math.round(history.savedInput).toLocaleString('en-US')}`);
  console.log(`input savings: ${round1(inputPct)}%`);
  console.log(`total spend savings: ${round1(totalPct)}%`);
  console.log(`estimated savings: $${(history.savedInput * inputPerMtok / 1e6).toFixed(4)}`);
  console.log(`current process requests: ${number(stats.requests).toLocaleString('en-US')}`);
  process.exit(0);
}

console.log('pxpipe stats');
console.log(`requests: ${number(stats.requests).toLocaleString('en-US')}`);
console.log(`compressed: ${number(stats.compressed_requests).toLocaleString('en-US')}`);
console.log(`saved input tokens: ${number(stats.saved_input_tokens).toLocaleString('en-US')}`);
console.log(`input savings: ${number(stats.saved_pct_input_only)}%`);
console.log(`total spend savings: ${number(stats.saved_pct_of_all_spend)}%`);
console.log(`estimated savings: $${number(stats.saved_usd).toFixed(4)}`);

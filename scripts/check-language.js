#!/usr/bin/env node
/**
 * Simple language guard: fails if common German words appear in source files.
 * Scans frontend/src and backend/src for string literals and template text.
 */
const fs = require('fs');
const path = require('path');

const roots = [
  path.join(__dirname, '..', 'frontend', 'src'),
  path.join(__dirname, '..', 'backend', 'src'),
];

const germanWords = [
  'Fehler', 'Warnung', 'Zugriff', 'Bitte', 'Speichern', 'Abbrechen', 'Neustart', 'Schlüssel',
  'Öffnen', 'Schließen', 'Benutzer', 'Passwort', 'Konfiguration', 'Konfigurieren', 'Einstellungen',
  'Dienst', 'Server', 'nicht', 'noch', 'ist', 'sind', 'SSH Fehler', 'Fehlerdetails'
];

const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.html']);

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        const ext = path.extname(e.name);
        if (exts.has(ext)) out.push(p);
      }
    }
  }
  return out;
}

function checkFile(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const hits = [];
  for (const w of germanWords) {
    const re = new RegExp(`\\b${w.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(txt)) hits.push(w);
  }
  return hits.length ? { file, hits } : null;
}

let violations = [];
for (const root of roots) {
  const files = listFiles(root);
  for (const f of files) {
    const v = checkFile(f);
    if (v) violations.push(v);
  }
}

if (violations.length) {
  console.error('German language strings detected in project:');
  for (const v of violations) {
    console.error(`- ${v.file}: ${v.hits.join(', ')}`);
  }
  process.exit(1);
} else {
  console.log('Language check passed: no German strings found.');
}

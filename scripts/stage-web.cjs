#!/usr/bin/env node
/*
 * Stages the Film Lab web app shell into www/ so Capacitor can copy it into the
 * native Android project. The site itself lives at the repository root; this
 * step only mirrors the files the app needs at runtime and keeps build tooling,
 * tests and dependencies out of the APK.
 *
 * Usage: npm run web:stage  (or FILM_LAB_STAGE_DIR=/tmp/out node scripts/stage-web.cjs)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.FILM_LAB_STAGE_DIR
  ? path.resolve(process.env.FILM_LAB_STAGE_DIR)
  : path.join(ROOT, 'www');

// Directories and files that belong to the repository, not to the app bundle.
const SKIP = new Set([
  '.git',
  '.github',
  '.arena',
  '.arena-tmp',
  'android',
  'ios',
  'dist-electron',
  'electron',
  'node_modules',
  'scripts',
  'tests',
  'www',
  '.DS_Store',
  '.gitignore',
  'capacitor.config.json',
  'DOWNLOADS.md',
  'package-lock.json',
  'package.json',
  'README-BUILD.md',
  'README.md',
]);

function shouldSkip(name) {
  return SKIP.has(name) || name.endsWith('.log');
}

function stage(fromDir, toDir, stats) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const source = path.join(fromDir, entry.name);
    const destination = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      stage(source, destination, stats);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, destination);
      stats.files += 1;
      stats.bytes += fs.statSync(destination).size;
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error(`Cannot stage the web app: ${path.join(ROOT, 'index.html')} is missing`);
    process.exit(1);
  }

  fs.rmSync(TARGET, { recursive: true, force: true });
  const stats = { files: 0, bytes: 0 };
  stage(ROOT, TARGET, stats);

  if (!fs.existsSync(path.join(TARGET, 'index.html'))) {
    console.error(`Staging failed: ${path.join(TARGET, 'index.html')} was not created`);
    process.exit(1);
  }

  const size = (stats.bytes / 1024 / 1024).toFixed(1);
  console.log(`Staged ${stats.files} files (${size} MB) into ${path.relative(ROOT, TARGET) || TARGET}`);
  console.log('Next: npx cap sync android');
}

main();

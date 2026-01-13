#!/usr/bin/env node
/**
 * Syncs dependencies from backend/package.json to root package.json
 * This ensures that when the npm package is installed globally,
 * all required dependencies are available.
 * 
 * Optionally updates package-lock.json if --update-lock is provided.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const backendPackageJsonPath = join(rootDir, 'backend', 'package.json');
const rootPackageJsonPath = join(rootDir, 'package.json');

// Check if --update-lock flag is provided
const updateLock = process.argv.includes('--update-lock');

// Read both package.json files
const backendPackage = JSON.parse(readFileSync(backendPackageJsonPath, 'utf-8'));
const rootPackage = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));

// Check if dependencies changed
const oldDependencies = JSON.stringify(rootPackage.dependencies || {});
let dependenciesChanged = false;

// Sync dependencies from backend to root
if (backendPackage.dependencies) {
  rootPackage.dependencies = { ...backendPackage.dependencies };
  const newDependencies = JSON.stringify(rootPackage.dependencies);
  dependenciesChanged = oldDependencies !== newDependencies;
  
  // Write to stderr to avoid interfering with npm pack --json
  console.error('✓ Synced dependencies from backend/package.json to root package.json');
  console.error(`  ${Object.keys(rootPackage.dependencies).length} dependencies synced`);
} else {
  console.error('⚠️  No dependencies found in backend/package.json');
}

// Write updated root package.json
writeFileSync(rootPackageJsonPath, JSON.stringify(rootPackage, null, 2) + '\n');
console.error('✓ Updated root package.json');

// Update package-lock.json if requested and dependencies changed
if (updateLock && dependenciesChanged) {
  console.error('Updating package-lock.json...');
  const npm = spawn('npm', ['install', '--package-lock-only'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  });
  
  npm.on('close', (code) => {
    if (code === 0) {
      console.error('✓ Updated package-lock.json');
      process.exit(0);
    } else {
      console.error('✗ Failed to update package-lock.json');
      process.exit(code || 1);
    }
  });
  
  npm.on('error', (err) => {
    console.error('✗ Error running npm install:', err);
    process.exit(1);
  });
} else if (updateLock && !dependenciesChanged) {
  console.error('ℹ️  Dependencies unchanged, skipping package-lock.json update');
}


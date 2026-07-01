#!/usr/bin/env node

/**
 * Fix for http-proxy package util._extend deprecation warning
 * This script patches the http-proxy package to use Object.assign instead of util._extend
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixHttpProxyDeprecation() {
  try {
    const candidateDirs = [
      path.join(__dirname, 'node_modules', 'http-proxy', 'lib', 'http-proxy'),
    ];

    const bunStoreDir = path.join(__dirname, 'node_modules', '.bun');
    if (fs.existsSync(bunStoreDir)) {
      for (const entry of fs.readdirSync(bunStoreDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('http-proxy@')) continue;
        candidateDirs.push(path.join(bunStoreDir, entry.name, 'node_modules', 'http-proxy', 'lib', 'http-proxy'));
      }
    }

    for (const httpProxyDir of candidateDirs) {
      patchHttpProxyDir(httpProxyDir);
    }
  } catch {
    // Silently handle errors - functionality is not affected
  }
}

function patchHttpProxyDir(httpProxyDir) {
  const indexPath = path.join(httpProxyDir, 'index.js');
  const commonPath = path.join(httpProxyDir, 'common.js');

  if (!fs.existsSync(indexPath) || !fs.existsSync(commonPath)) {
    return;
  }

    if (fs.existsSync(indexPath)) {
      let content = fs.readFileSync(indexPath, 'utf8');
      
      let indexPatched = false;
      
      if (content.includes("require('util')._extend")) {
        content = content.replace(
          /extend\s*=\s*require\('util'\)\._extend,/,
          "extend = Object.assign,"
        );
        indexPatched = true;
      }
      
      if (content.includes("require('util').inherits")) {
        content = content.replace(
          /require\('util'\)\.inherits\((\w+),\s*(\w+)\);/,
          "Object.setPrototypeOf($1.prototype, $2.prototype);"
        );
        indexPatched = true;
      }
      
      if (indexPatched) {
        fs.writeFileSync(indexPath, content, 'utf8');
      }
    }

    if (fs.existsSync(commonPath)) {
      let content = fs.readFileSync(commonPath, 'utf8');
      
      let commonPatched = false;
      
      if (content.includes("require('util')._extend")) {
        content = content.replace(
          /extend\s*=\s*require\('util'\)\._extend,/,
          "extend = Object.assign,"
        );
        commonPatched = true;
      }
      
      if (commonPatched) {
        fs.writeFileSync(commonPath, content, 'utf8');
      }
    }
}

// Run the fix
fixHttpProxyDeprecation();

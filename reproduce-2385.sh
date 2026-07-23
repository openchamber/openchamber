#!/usr/bin/env bash
set -euo pipefail

# Reproduction script for issue #2385
# Docker build fails at `bun install --frozen-lockfile` because the
# bun-patches/ directory is not copied into the build context before
# running bun install.

echo "=== Issue #2385 Reproduction ==="
echo "Building Docker image to the 'deps' stage..."
echo ""

if docker build --target deps -t openchamber-issue-2385 . 2>&1; then
  echo ""
  echo "UNEXPECTED: Build succeeded. The issue may have been fixed."
  exit 0
else
  echo ""
  echo "EXPECTED: Build failed with the patch file error."
  echo "Root cause: Dockerfile 'deps' stage copies package.json and bun.lock"
  echo "but does NOT copy the bun-patches/ directory. The lockfile references"
  echo "bun-patches/@tanstack+virtual-core+3.17.3.patch which is missing."
  echo ""
  echo "Fix: Add 'COPY bun-patches ./bun-patches' before 'RUN bun install'"
  echo "in the 'deps' stage of the Dockerfile."
  exit 1
fi

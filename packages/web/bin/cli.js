#!/usr/bin/env node

import { existsSync } from 'node:fs';

const sourceLoader = new URL('../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);

const runtime = await import('./cli-runtime.js');

export const {
  main, commands, parseArgs, assertAuthenticatedNetworkExposure,
  resolveServeHost, hasUiPasswordConfigured, generateUiPassword, resolveServeUiPassword,
  shouldDisplayTunnelQr, isValidTunnelDoctorResponse, readDesktopLocalPortFromSettings,
  getPidFilePath, getInstanceFilePath, isProcessRunning, isOpenchamberProcessRunning,
  isOpenchamberCmdline, getOpenchamberProcessState, resolveTunnelProviders,
  fetchTunnelProvidersFromPort, fetchSystemInfoFromPort, discoverRunningInstances,
  discoverOpenChamberInstanceOnPort, discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort, ensureTunnelProfilesMigrated,
  resolveToken, redactProfileForOutput, redactProfilesForOutput, maskToken,
  findClosestMatch, generateCompletionScript, TunnelCliError, EXIT_CODE,
  warnIfUnsafeFilePermissions,
} = runtime;

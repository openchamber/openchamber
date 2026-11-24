#!/usr/bin/env node

import { existsSync } from 'node:fs';

const sourceLoader = new URL('../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);

const builtCli = new URL('../build/bin/cli.js', import.meta.url);
const legacyEntry = !existsSync(sourceLoader) && existsSync(builtCli);
const runtime = await import(legacyEntry ? new URL('../build/bin/cli-runtime.js', import.meta.url).href : './cli-runtime.js');

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

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { isTauriShell } from "@/lib/desktop";
import { matchesFuzzyQuery } from "@/lib/search/fuzzySearch";
import type { I18nKey } from "@/lib/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Detects if the current platform is macOS.
 * Uses navigator.userAgent in browser environments.
 */
export const isMacOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
};

export const isWindows = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Windows/.test(navigator.userAgent || '');
};

export const getRevealLabelKey = (): I18nKey => {
  if (isMacOS()) return 'common.revealPath.finder';
  if (isWindows()) return 'common.revealPath.fileExplorer';
  return 'common.revealPath.fileManager';
};

/**
 * Checks if the platform-appropriate modifier key is pressed.
 * On macOS desktop app: Cmd (metaKey), on other platforms or web: Ctrl (ctrlKey).
 * Browser intercepts Cmd shortcuts, so we only use Cmd in Tauri desktop app.
 */
export const hasModifier = (e: KeyboardEvent | React.KeyboardEvent): boolean => {
  return isMacOS() && isTauriShell() ? e.metaKey : e.ctrlKey;
};

/**
 * Returns the platform-appropriate modifier key label.
 * On macOS desktop app: "⌘", on other platforms or web: "Ctrl"
 * Browser intercepts Cmd shortcuts, so we only show Cmd in Tauri desktop app.
 */
export const getModifierLabel = (): string => {
  return isMacOS() && isTauriShell() ? '⌘' : 'Ctrl';
};

export const truncatePathMiddle = (
  value: string,
  options?: { maxLength?: number }
): string => {
  const source = value ?? "";
  const maxLength = Math.max(16, options?.maxLength ?? 45);
  if (source.length <= maxLength) {
    return source;
  }

  const segments = source.split('/');
  if (segments.length <= 1) {
    return source;
  }

  const fileName = segments.pop() ?? '';
  if (!fileName) {
    return source;
  }

  const prefixBudget = Math.max(0, maxLength - (fileName.length + 2));
  if (prefixBudget <= 0) {
    return `…/${fileName}`;
  }

  let prefix = '';
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    const candidate = prefix ? `${prefix}/${segment}` : segment;
    if (candidate.length > prefixBudget) {
      break;
    }
    prefix = candidate;
  }

  if (!prefix) {
    const first = segments[0] ?? '';
    prefix = first ? first.slice(0, prefixBudget) : '';
  }

  return prefix ? `${prefix}…/${fileName}` : `…/${fileName}`;
};

const normalizePath = (value: string) => {
  if (!value) return "";
  if (value === "/") return "/";
  return value.replace(/\/+$/, "");
};

export function formatPathForDisplay(path: string | null | undefined, homeDirectory?: string | null): string {
  if (!path) {
    return "";
  }

  const normalizedPath = normalizePath(path);
  if (normalizedPath === "/") {
    return "/";
  }

  const normalizedHome = homeDirectory ? normalizePath(homeDirectory) : undefined;

  if (normalizedHome && normalizedHome !== "/") {
    if (normalizedPath === normalizedHome) {
      return "~";
    }
    if (normalizedPath.startsWith(`${normalizedHome}/`)) {
      const relative = normalizedPath.slice(normalizedHome.length + 1);
      return relative ? `~/${relative}` : "~";
    }
  }

  return normalizedPath;
}

export function formatDirectoryName(path: string | null | undefined, homeDirectory?: string | null): string {
  if (!path) {
    return "/";
  }

  const normalizedPath = normalizePath(path);
  if (!normalizedPath || normalizedPath === "/") {
    return "/";
  }

  const normalizedHome = homeDirectory ? normalizePath(homeDirectory) : undefined;
  if (normalizedHome && normalizedHome !== "/" && normalizedPath === normalizedHome) {
    return "~";
  }

  const segments = normalizedPath.split("/");
  const name = segments.pop() || normalizedPath;
  return name || "/";
}

/**
 * Fuzzy search using Fuse.js with typo tolerance.
 * Returns true if query fuzzy-matches target (e.g. "coude" matches "claude")
 */
export function fuzzyMatch(target: string, query: string): boolean {
  return matchesFuzzyQuery(target, query);
}

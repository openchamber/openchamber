import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { matchesFuzzyQuery } from "@/lib/search/fuzzySearch";
import type { I18nKey } from "@/lib/i18n";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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

  let suffix = fileName;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!segment) {
      continue;
    }
    const candidate = `${segment}/${suffix}`;
    if (candidate.length + 2 > maxLength) {
      break;
    }
    suffix = candidate;
  }

  return `…/${suffix}`;
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

export function fuzzyMatch(target: string, query: string): boolean {
  return matchesFuzzyQuery(target, query);
}

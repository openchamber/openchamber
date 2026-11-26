import { isTrackerUrlTemplate } from './manifest.ts';

const WILDCARD_PREFIX = 'https://*.';
const NAMED_HOST_LABEL = /^[a-z0-9_-]+$/;

export const isBuildableLinkTemplate = (template: string): boolean => (
  isTrackerUrlTemplate(template) && !template.includes('{segment}') && !template.includes('{segments+}')
);

export const buildLinkUrl = (origin: string, template: string, identifier: string): string => (
  `${origin}${template.replace('{id}', encodeURIComponent(identifier))}`
);

export const isWildcardLinkOrigin = (origin: string): boolean => origin.startsWith(WILDCARD_PREFIX);

export const linkOriginValidator = (isExactOrigin: (origin: string) => boolean) => (value: string): boolean => {
  if (!isWildcardLinkOrigin(value)) return isExactOrigin(value);
  const apex = `https://${value.slice(WILDCARD_PREFIX.length)}`;
  return isExactOrigin(apex) && new URL(apex).port === '';
};

export const linkOriginMatches = (pattern: string, origin: string): boolean => {
  if (!isWildcardLinkOrigin(pattern)) return origin === pattern;
  const suffix = `.${pattern.slice(WILDCARD_PREFIX.length)}`;
  const host = origin.startsWith('https://') ? origin.slice('https://'.length) : '';
  return host.endsWith(suffix) && host.slice(0, -suffix.length).split('.').every((label) => NAMED_HOST_LABEL.test(label));
};

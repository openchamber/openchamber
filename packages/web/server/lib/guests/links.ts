import { compileTrackerUrlTemplate, identifierPatternOf } from '../trackers/extension-descriptor.js';
import type { LinksContribution } from '@openchamber/sdk';

export const toPublicLinks = (links: LinksContribution) => {
  const declaredUrls = links.urls;
  const urls = declaredUrls
    ? {
      origin: declaredUrls.origin,
      identifierPattern: identifierPatternOf(declaredUrls.identifier),
      patterns: declaredUrls.item.map((template) => compileTrackerUrlTemplate(template, declaredUrls.identifier)),
      itemTemplate: declaredUrls.item.find((template) => !template.includes('{segment')) ?? null,
    }
    : null;
  return { action: links.action, keys: [...(links.identifier?.keys ?? [])], urls };
};

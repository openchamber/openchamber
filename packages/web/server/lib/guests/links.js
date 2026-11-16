import { compileTrackerUrlTemplate, identifierPatternOf } from '../trackers/extension-descriptor.js';

/**
 * `contributes.links` as the catalog row carries it to the UI: what a click
 * does, the literal identifier keys, and the link templates compiled by the
 * tracker's compiler (`../trackers/extension-descriptor.js`), so a package
 * never supplies a regular expression and the UI never compiles a template.
 * `itemTemplate` is the first template the host can fill from an identifier
 * alone, which names the link of a chip or of an identifier in text.
 *
 * @param {{ action: 'open' | 'attach', identifier?: { keys: string[] }, urls?: { origin: string, identifier: 'key-number' | 'number' | 'short-code', item: string[] } }} links
 * @returns {{ action: 'open' | 'attach', keys: string[], urls: { origin: string, identifierPattern: string, patterns: Array<{ path: string, query?: { name: string } }>, itemTemplate: string | null } | null }}
 */
export const toPublicLinks = (links) => {
  const urls = links.urls
    ? {
      origin: links.urls.origin,
      identifierPattern: identifierPatternOf(links.urls.identifier),
      patterns: links.urls.item.map((template) => compileTrackerUrlTemplate(template, links.urls.identifier)),
      itemTemplate: links.urls.item.find((template) => !template.includes('{segment')) ?? null,
    }
    : null;
  return { action: links.action, keys: [...(links.identifier?.keys ?? [])], urls };
};

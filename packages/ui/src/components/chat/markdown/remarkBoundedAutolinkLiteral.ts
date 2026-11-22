import type { Construct, Event, Extension, Token, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

// external: https://github.com/micromark/micromark-extension-gfm-autolink-literal
// Before each email, www or protocol literal the tokenizer walks back over the
// paragraph's events to an unbalanced `[` (previousUnbalanced). It remembers only
// walks that found none, so after an unbalanced `[` every attempt walks back to it
// and the paragraph costs the square of its length: the JSON dump from
// openchamber/openchamber#4204, which opens with `[`, took seconds. This answers
// the same question and remembers the label it found, so the tokenizer declines
// at once, as it would after its own walk.
declare module 'micromark-util-types' {
  interface Token {
    _gfmAutolinkLiteralWalkedInto?: boolean;
  }
}

const LITERAL_CONSTRUCTS = new Set(['wwwAutolink', 'protocolAutolink', 'emailAutolink']);

const isUnbalancedLabel = (token: Token): boolean => (
  (token.type === 'labelLink' || token.type === 'labelImage') && token._balanced !== true
);

const unbalancedLabels = new WeakMap<Event[], { index: number; token: Token }>();

const previousUnbalanced = (events: Event[]): boolean => {
  const known = unbalancedLabels.get(events);
  if (known && events[known.index]?.[1] === known.token && isUnbalancedLabel(known.token)) return true;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const token = events[index][1];
    if (isUnbalancedLabel(token)) {
      unbalancedLabels.set(events, { index, token });
      return true;
    }
    if (token._gfmAutolinkLiteralWalkedInto === true) break;
  }
  unbalancedLabels.delete(events);
  return false;
};

const bounded = new WeakMap<Construct, Construct>();

const boundConstruct = (construct: Construct): Construct => {
  if (!construct.name || !LITERAL_CONSTRUCTS.has(construct.name)) return construct;
  const known = bounded.get(construct);
  if (known) return known;
  const { tokenize } = construct;
  const tokenizeBounded: Tokenizer = function (effects, ok, nok) {
    if (previousUnbalanced(this.events)) return nok;
    return tokenize.call(this, effects, ok, nok);
  };
  const wrapped: Construct = { ...construct, tokenize: tokenizeBounded };
  bounded.set(construct, wrapped);
  return wrapped;
};

const boundExtension = (extension: Extension): Extension => {
  if (!extension.text) return extension;
  const text: NonNullable<Extension['text']> = {};
  for (const [code, constructs] of Object.entries(extension.text)) {
    if (!constructs) continue;
    text[Number(code)] = Array.isArray(constructs) ? constructs.map(boundConstruct) : boundConstruct(constructs);
  }
  return { ...extension, text };
};

export function remarkBoundedAutolinkLiteral(this: Processor) {
  const extensions = this.data('micromarkExtensions');
  if (extensions) this.data('micromarkExtensions', extensions.map(boundExtension));
}

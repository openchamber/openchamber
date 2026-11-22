import type { Construct, Extension, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

// external: https://github.com/micromark/micromark-extension-gfm-autolink-literal
// Before each email, www or protocol literal the tokenizer walks back over every
// event of the paragraph so far (previousUnbalanced), so one long paragraph costs
// the square of its length: the data dump from openchamber/openchamber#4204 took
// seconds to render. Past AUTOLINK_LITERAL_EVENT_LIMIT events the tokenizer steps
// aside; mdast-util-gfm-autolink-literal still links bare URLs in the text, in a
// single linear pass.
export const AUTOLINK_LITERAL_EVENT_LIMIT = 5_000;

const LITERAL_CONSTRUCTS = new Set(['wwwAutolink', 'protocolAutolink', 'emailAutolink']);
const bounded = new WeakMap<Construct, Construct>();

const boundConstruct = (construct: Construct): Construct => {
  if (!construct.name || !LITERAL_CONSTRUCTS.has(construct.name)) return construct;
  const known = bounded.get(construct);
  if (known) return known;
  const { tokenize } = construct;
  const tokenizeBounded: Tokenizer = function (effects, ok, nok) {
    if (this.events.length > AUTOLINK_LITERAL_EVENT_LIMIT) return nok;
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

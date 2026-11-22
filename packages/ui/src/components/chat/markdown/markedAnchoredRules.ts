import { Lexer } from 'marked';

/**
 * marked runs each block rule on the rest of the message at every block, and
 * each inline rule on the rest of the paragraph at every token. Its rules
 * start with `^`, and V8 gives up on them at the first character that does
 * not match. Older JavaScriptCore (Bun 1.3.11; Safari and the iOS app's
 * WebView before the WebKit in macOS 27.0.1) retries a failed `^` match at
 * every later position, so each call reads the whole remainder and a long
 * message costs the square of its length: 16,000 short paragraphs took about
 * 70 s in Bun 1.3.11 and the hr rule alone 7.9 s in that system
 * JavaScriptCore, against milliseconds in Node. Bun 1.4.3 and the newer
 * JavaScriptCore are fast either way; the pin keeps older Safari and iOS fast.
 *
 * The sticky flag (`y`) limits a match to one position in every engine. marked
 * never resets `lastIndex`, and a sticky match moves it, so `exec` starts every
 * match at 0, which is where `^` anchors it anyway. Matches are therefore the
 * same as before. Global rules keep `lastIndex` for marked's own loops and are
 * left as they are, as is `rules.other`. `split` and `matchAll` construct their
 * own regex through the species, which stays plain `RegExp`.
 */
class AnchoredRule extends RegExp {
  static override get [Symbol.species]() {
    return RegExp;
  }

  override exec(input: string): RegExpExecArray | null {
    this.lastIndex = 0;
    return super.exec(input);
  }
}

const shouldPin = (rule: RegExp): boolean => (
  rule.source.startsWith('^') && !rule.global && !rule.sticky && !(rule instanceof AnchoredRule)
);

/** Replaces marked's anchored block and inline rules in place. Idempotent. */
export const pinMarkedAnchoredRules = (): number => {
  let pinned = 0;
  const { block, inline } = Lexer.rules;
  for (const modes of [block, inline]) {
    for (const rules of Object.values(modes)) {
      for (const [name, rule] of Object.entries(rules)) {
        if (!(rule instanceof RegExp) || !shouldPin(rule)) continue;
        Reflect.set(rules, name, new AnchoredRule(rule.source, `${rule.flags}y`));
        pinned += 1;
      }
    }
  }
  return pinned;
};

/**
 * Text that tries to talk to the model rather than describe something.
 *
 * Memory is the one place where text from outside can settle permanently. The
 * agent browses a page, decides a line on it is worth keeping, and saves it —
 * from then on it rides into every session in every project. An injection
 * anywhere else lives for one conversation; here it lives until someone
 * notices.
 *
 * Patterns, not a model: this runs on every write and every index build, and a
 * classifier there would cost more than the whole feature. That buys only the
 * blunt cases, which is the honest expectation — it raises the floor rather
 * than closing the door.
 *
 * A match never deletes anything. The entry is stored, kept out of what the
 * model is shown, and flagged for the user, because a silently dropped entry
 * hides the attempt from the only party who can judge it.
 */

const PATTERNS = [
  // Trying to displace instructions already in play.
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?|context)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\bforget\s+(?:everything|all)\s+(?:you|above|before)\b/i,
  /\boverrid(?:e|ing)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)\b/i,

  // Trying to reassign who the model is.
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bfrom\s+now\s+on[,\s]+(?:you|act|behave|respond)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+are\s+)?(?:a|an|the)\s+\w+\s+with\s+no\s+(?:restrictions?|limits?|rules?)\b/i,

  // Forging turn structure so the text reads as a different speaker.
  /^\s*(?:system|assistant|developer)\s*:/im,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\[\/?(?:INST|SYS)\]/,

  // Aimed at the guardrails themselves.
  /\b(?:bypass|disable|turn\s+off)\s+(?:all\s+)?(?:safety|security|guardrails?|filters?|restrictions?)\b/i,
  /\bdeveloper\s+mode\s+(?:enabled|on|activated)\b/i,

  // Asking for what the model was told, or for credentials to travel.
  /\b(?:print|reveal|repeat|output|show)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|instructions|initial\s+prompt)\b/i,
  /\b(?:send|post|upload|exfiltrate)\s+(?:the\s+|your\s+)?(?:api\s+key|token|credentials?|secrets?|env)\b/i,
];

/**
 * The first pattern this text trips, or null. The name is returned rather than
 * a boolean so the panel can tell the user what was matched instead of leaving
 * them with an unexplained warning.
 */
export const findThreatPattern = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const match = PATTERNS.find((pattern) => pattern.test(value));
  return match ? match.source.slice(0, 80) : null;
};

export const looksLikeInjection = (...values) => (
  values.some((value) => findThreatPattern(value) !== null)
);

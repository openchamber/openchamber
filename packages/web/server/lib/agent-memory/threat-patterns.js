const PATTERNS = [
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?|context)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\bforget\s+(?:everything|all)\s+(?:you|above|before)\b/i,
  /\boverrid(?:e|ing)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)\b/i,

  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bfrom\s+now\s+on[,\s]+(?:you|act|behave|respond)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+are\s+)?(?:a|an|the)\s+\w+\s+with\s+no\s+(?:restrictions?|limits?|rules?)\b/i,

  /^\s*(?:system|assistant|developer)\s*:/im,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
  /\[\/?(?:INST|SYS)\]/,

  /\b(?:bypass|disable|turn\s+off)\s+(?:all\s+)?(?:safety|security|guardrails?|filters?|restrictions?)\b/i,
  /\bdeveloper\s+mode\s+(?:enabled|on|activated)\b/i,

  /\b(?:print|reveal|repeat|output|show)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|instructions|initial\s+prompt)\b/i,
  /\b(?:send|post|upload|exfiltrate)\s+(?:the\s+|your\s+)?(?:api\s+key|token|credentials?|secrets?|env)\b/i,
];

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

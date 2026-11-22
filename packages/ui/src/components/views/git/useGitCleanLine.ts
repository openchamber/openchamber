import React from 'react';

import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { gitCleanLine } from '@/lib/easter-eggs/lines';

export function useGitCleanLine(fallback: string): string {
  const copy = useEasterEggCopy();
  const [pick] = React.useState(() => ({ at: new Date(), seed: Math.floor(Math.random() * 1000) }));
  return (copy ? gitCleanLine(copy, pick.at, pick.seed) : null) ?? fallback;
}

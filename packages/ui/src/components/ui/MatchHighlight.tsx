import React from 'react';

import type { MatchSegment } from '@/lib/search/matchSegments';

export const MatchHighlight: React.FC<{ segments: ReadonlyArray<MatchSegment> }> = ({ segments }) => (
  <>
    {segments.map((segment, index) => (segment.matched
      ? <mark key={index} className="rounded-[2px] bg-primary/25 text-foreground">{segment.text}</mark>
      : <React.Fragment key={index}>{segment.text}</React.Fragment>))}
  </>
);

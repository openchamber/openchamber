import React from 'react';
import { resolveDelimiter, type TableDelimiter } from '../previews/tableDelimiter';

export const useTableDelimiter = (path: string | null, source: string, sourceRevision: number): TableDelimiter => {
  const key = path === null ? null : `${sourceRevision}:${path.toLowerCase().endsWith('.tsv')}`;
  const read = () => (path === null ? ',' : resolveDelimiter(path, source));
  const [remembered, setRemembered] = React.useState(() => ({ key, delimiter: read() }));
  if (remembered.key === key) return remembered.delimiter;
  const next = { key, delimiter: read() };
  setRemembered(next);
  return next.delimiter;
};

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Names a mark on a sidebar row (a status glyph, a badge, the project icon)
 * in a tooltip above it. Beside the mark it would cover the neighbouring
 * marks and the row's hover actions; only the whole-row tooltip opens to the
 * side. `children` is the mark itself, a single element that takes a ref.
 */
export const RowMarkTooltip: React.FC<{ label: string; children: React.ReactElement }> = ({ label, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>
);

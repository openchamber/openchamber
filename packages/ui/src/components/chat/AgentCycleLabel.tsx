import React from 'react';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/chat/AgentAvatar';

/** Expand / collapse duration — same curve both ways. */
export const AGENT_CYCLE_LABEL_ANIM_MS = 280;

/** How long the name stays fully open before the matching collapse starts. */
export const AGENT_CYCLE_LABEL_HOLD_MS = 1000;

type AgentCycleLabelProps = {
  name: string | undefined;
  label: string;
  revealed: boolean;
  avatarSize: number;
  /** Fixed square that matches other composer icon buttons while collapsed. */
  slotClassName: string;
  colorVar?: string;
};

/**
 * Avatar + name that opens/closes with a symmetric grid 0fr↔1fr transition.
 * Outer chrome must stay stable (no chip↔square class swap) or the out animation pops.
 */
export const AgentCycleLabel: React.FC<AgentCycleLabelProps> = ({
  name,
  label,
  revealed,
  avatarSize,
  slotClassName,
  colorVar,
}) => {
  return (
    <>
      <span className={cn('inline-flex shrink-0 items-center justify-center', slotClassName)}>
        <AgentAvatar
          name={name}
          size={avatarSize}
          label={revealed ? undefined : label}
        />
      </span>
      <span
        className={cn(
          'grid min-w-0 ease-in-out',
          revealed ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0',
        )}
        style={{
          transitionProperty: 'grid-template-columns, opacity',
          transitionDuration: `${AGENT_CYCLE_LABEL_ANIM_MS}ms`,
          transitionTimingFunction: 'ease-in-out',
        }}
        aria-hidden={!revealed}
      >
        <span className="min-w-0 overflow-hidden">
          <span
            className="inline-block whitespace-nowrap pl-1.5 pr-0.5 typography-micro font-medium"
            style={colorVar ? { color: `var(${colorVar})` } : undefined}
          >
            {label}
          </span>
        </span>
      </span>
    </>
  );
};

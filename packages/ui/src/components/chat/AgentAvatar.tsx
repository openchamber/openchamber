import React from 'react';
import { getAgentColor } from '@/lib/agentColors';
import { getAgentIdenticonMatrix } from '@/lib/agentIdenticon';
import { cn } from '@/lib/utils';

type AgentAvatarProps = {
  /** Agent name seed — drives both pattern and theme color. */
  name: string | undefined;
  size?: number;
  className?: string;
  /** Accessible name when the surrounding control no longer shows text. */
  label?: string;
};

/**
 * Compact hash avatar for sub-agents (GitHub-style identicon + agent color token).
 */
export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  name,
  size = 16,
  className,
  label,
}) => {
  const color = getAgentColor(name);
  const matrix = React.useMemo(() => getAgentIdenticonMatrix(name), [name]);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-sm',
        color.class,
        className,
      )}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 5 5"
        shapeRendering="crispEdges"
        className="block h-full w-full"
      >
        <rect width="5" height="5" fill="rgb(from var(--agent-color) r g b / 0.14)" />
        {matrix.map((row, y) =>
          row.map((on, x) =>
            on ? (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width="1"
                height="1"
                fill="var(--agent-color)"
              />
            ) : null,
          ),
        )}
      </svg>
    </span>
  );
};

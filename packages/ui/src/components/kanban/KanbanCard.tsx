import React from 'react';
import { cn } from '@/lib/utils';
import type { BoardCard } from '@/types/kanban';

export interface KanbanCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  card: BoardCard;
  onCardClick?: (card: BoardCard) => void;
}

export const KanbanCard: React.FC<KanbanCardProps> = ({ card, onCardClick, onClick, className, ...props }) => {
  const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    onCardClick?.(card);
    onClick?.(event);
  }, [card, onCardClick, onClick]);

  const getStatusBadgeStyles = React.useCallback((): { bg: string; text: string } => {
    switch (card.status) {
      case 'running':
        return {
          bg: 'bg-[rgb(var(--status-warning)/0.1)]',
          text: 'text-[var(--status-warning)]',
        };
      case 'done':
        return {
          bg: 'bg-[rgb(var(--status-success)/0.1)]',
          text: 'text-[var(--status-success)]',
        };
      default:
        return {
          bg: 'bg-[rgb(var(--status-info)/0.1)]',
          text: 'text-[var(--status-info)]',
        };
    }
  }, [card.status]);

  return (
    <div
      onClick={handleClick}
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border border-border/30 bg-[var(--surface-elevated)] px-3 py-2.5',
        'transition-colors hover:border-border/50',
        (onClick || onCardClick) && 'cursor-pointer',
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex-1 typography-meta font-medium text-foreground truncate">
          {card.title}
        </h3>
        {card.status && (
          <span className={cn(
            'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 typography-micro font-medium',
            getStatusBadgeStyles().bg,
            getStatusBadgeStyles().text
          )}>
            {card.status}
          </span>
        )}
      </div>
      {card.description && (
        <p className="typography-micro text-muted-foreground line-clamp-2">
          {card.description}
        </p>
      )}
    </div>
  );
};

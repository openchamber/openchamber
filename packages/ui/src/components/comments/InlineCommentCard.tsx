import React, { useState } from 'react';
import { RiMoreLine, RiDeleteBinLine, RiEditLine, RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface InlineCommentCardProps {
  draft: InlineCommentDraft;
  onEdit: () => void;
  onDelete: () => void;
  className?: string;
  maxWidth?: number;
}

export function InlineCommentCard({
  draft,
  onEdit,
  onDelete,
  className,
  maxWidth,
}: InlineCommentCardProps) {
  const themeContext = useOptionalThemeSystem();
  const currentTheme = themeContext?.currentTheme;
  const [isOpen, setIsOpen] = useState(false);
  
  // Check if content is long enough to warrant collapsing (rough estimate)
  // In a real app we might measure line height, but length check is a good proxy for now
  const isLongContent = draft.text.length > 150 || draft.text.split('\n').length > 3;

  return (
    <div
      className={cn(
        "rounded-lg border shadow-none w-full max-w-[min(100%,calc(var(--oc-context-panel-width,100vw)-var(--oc-editor-gutter-width,0px)))] overflow-hidden transition-all duration-200",
        className
      )}
      style={{
        backgroundColor: currentTheme?.colors?.surface?.elevated,
        borderColor: currentTheme?.colors?.interactive?.border,
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
      }}
      data-comment-card="true"
    >
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1.5">
            <span className="truncate max-w-[200px]" title={draft.fileLabel}>
              {draft.fileLabel}
            </span>
            <span>•</span>
            <span>Lines {draft.startLine}-{draft.endLine}</span>
            {draft.side && <span>({draft.side})</span>}
          </div>
          
          <Collapsible open={isOpen || !isLongContent} onOpenChange={setIsOpen}>
            <div className={cn("text-sm whitespace-pre-wrap break-words leading-relaxed", !isOpen && isLongContent && "line-clamp-3")}>
              {draft.text}
            </div>
            
            {isLongContent && (
              <CollapsibleTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-0 mt-1 text-xs text-muted-foreground hover:text-foreground w-full justify-start"
                >
                  {isOpen ? (
                    <>
                      <RiArrowUpSLine className="size-3 mr-1" />
                      Show less
                    </>
                  ) : (
                    <>
                      <RiArrowDownSLine className="size-3 mr-1" />
                      Show more
                    </>
                  )}
                </Button>
              </CollapsibleTrigger>
            )}
            
            <CollapsibleContent>
              {/* Used for animation purposes if we want to animate height */}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 -mr-1 text-muted-foreground hover:text-foreground"
            >
              <RiMoreLine className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <RiEditLine className="size-4 mr-2" />
              Edit comment
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <RiDeleteBinLine className="size-4 mr-2" />
              Delete comment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

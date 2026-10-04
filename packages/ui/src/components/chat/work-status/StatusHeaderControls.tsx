import type { GuestStatusControl } from '@openchamber/sdk';
import type React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Props = {
  controls: GuestStatusControl[];
  onActivate: (id: string, value?: string) => void;
  layout: 'inline' | 'below';
};

export const StatusHeaderControls: React.FC<Props> = ({ controls, onActivate, layout }) => (
  <div
    data-work-status-controls
    className={layout === 'below'
      ? 'grid grid-cols-2 gap-1 px-1 pb-1'
      : 'flex shrink-0 items-center gap-1'}
  >
    {controls.map((control) => {
      if (control.kind === 'button') {
        return (
          <div key={control.id} data-work-status-control={control.id} className="min-w-0">
            <Button
              variant="ghost"
              size="xs"
              aria-label={control.label}
              disabled={control.disabled}
              onClick={() => onActivate(control.id)}
              className="max-w-[5rem]"
            >
              <span className="truncate">{control.label}</span>
            </Button>
          </div>
        );
      }

      const selectedOption = control.options.find((option) => option.value === control.value);
      return (
        <div key={control.id} data-work-status-control={control.id} className="min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`${control.label}: ${selectedOption?.label ?? control.value}`}
                disabled={control.disabled}
                className="max-w-[5rem] gap-1"
              >
                <span className="min-w-0 truncate">{selectedOption?.label ?? control.value}</span>
                <Icon name="arrow-down-s" className="size-3 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuRadioGroup value={control.value} onValueChange={(value) => onActivate(control.id, value)}>
                {control.options.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    })}
  </div>
);

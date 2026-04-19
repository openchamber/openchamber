import * as React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';

const DEFAULT_SHELL = 'default';
type TerminalShellPreference = 'default' | 'powershell' | 'cmd' | 'bash' | 'wsl';

const baseOptions: Array<{ value: TerminalShellPreference; label: string }> = [
  { value: 'default', label: 'System Default' },
  { value: 'bash', label: 'Bash / POSIX Shell' },
];

const windowsOptions: Array<{ value: TerminalShellPreference; label: string }> = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'Command Prompt' },
  { value: 'wsl', label: 'WSL' },
];

export const TerminalSettings: React.FC = () => {
  const [value, setValue] = React.useState<TerminalShellPreference>(DEFAULT_SHELL);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);

  const isWindows = typeof navigator !== 'undefined'
    ? navigator.userAgent.includes('Windows')
    : false;
  const options = React.useMemo(
    () => (isWindows ? [...baseOptions, ...windowsOptions] : baseOptions),
    [isWindows],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const data = await response.json().catch(() => null);
        if (cancelled || !data || typeof data !== 'object') {
          return;
        }
        const next = typeof data.terminalShell === 'string' ? data.terminalShell.trim().toLowerCase() : DEFAULT_SHELL;
        setValue(options.some((option) => option.value === next) ? next as TerminalShellPreference : DEFAULT_SHELL);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [options]);

  const handleValueChange = React.useCallback(async (nextValue: TerminalShellPreference) => {
    setValue(nextValue);
    setIsSaving(true);
    try {
      await updateDesktopSettings({ terminalShell: nextValue });
    } catch (error) {
      console.warn('Failed to save terminal shell preference:', error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  if (isVSCodeRuntime()) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">Terminal</h3>
      </div>

      <section className="space-y-0.5 px-2 pb-2 pt-0">
        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 shrink-0 flex-col">
            <span className="typography-ui-label text-foreground">Preferred Shell</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:w-[18rem]">
            <Select value={value} onValueChange={(nextValue) => { void handleValueChange(nextValue as TerminalShellPreference); }} disabled={isLoading || isSaving}>
              <SelectTrigger className="min-w-[14rem]">
                <SelectValue placeholder="System Default" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="py-1.5">
          <div className="typography-micro text-muted-foreground/70">
            New terminal sessions use this shell preference. Existing sessions keep their current shell until restarted.
          </div>
        </div>
      </section>
    </div>
  );
};

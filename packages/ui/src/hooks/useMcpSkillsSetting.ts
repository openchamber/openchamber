import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const useMcpSkillsSetting = (onSaved: () => void) => {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    opencodeClient.getConfig(null).then(
      (config) => {
        if (!cancelled && latestWrite.current === 0) setEnabled(config.experimental?.mcp_skills === true);
      },
      (error) => console.warn('[mcp-skills] failed to read config', error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: boolean) => {
    const previous = enabled;
    const write = ++latestWrite.current;
    setEnabled(next);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/config/skill-mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reportSettingsSaveState('saved');
      opencodeClient.clearConfigCache();
      onSaved();
    } catch (error) {
      console.warn('[mcp-skills] failed to save', error);
      reportSettingsSaveState('error');
      if (write === latestWrite.current) setEnabled(previous);
    }
  };

  return { enabled, save };
};

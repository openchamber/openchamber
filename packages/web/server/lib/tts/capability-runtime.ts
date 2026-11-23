export interface SayVoice {
  name: string;
  locale: string;
}

export interface SayTtsCapability {
  available: boolean;
  voices: SayVoice[];
  reason?: string;
}

export const detectSayTtsCapability = async (processLike: Pick<NodeJS.Process, 'platform'>) => {
  let sayTTSCapability: SayTtsCapability = { available: false, voices: [], reason: 'Not checked' };

  if (processLike.platform === 'darwin') {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync('say -v "?"');
      const voices = stdout.split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const match = line.match(/^(.+?)\s+([a-zA-Z]{2}_[a-zA-Z]{2,3})\s+#/);
          if (match && match[1] !== undefined && match[2] !== undefined) {
            return { name: match[1].trim(), locale: match[2] };
          }
          return null;
        })
        .filter((voice) => voice !== null);
      sayTTSCapability = { available: true, voices };
      console.log(`macOS Say TTS available with ${voices.length} voices`);
    } catch (error) {
      sayTTSCapability = { available: false, voices: [], reason: 'say command not available' };
      console.log('macOS Say TTS not available:', error instanceof Error ? error.message : undefined);
    }
  } else {
    sayTTSCapability = { available: false, voices: [], reason: 'Not macOS' };
  }

  return sayTTSCapability;
};

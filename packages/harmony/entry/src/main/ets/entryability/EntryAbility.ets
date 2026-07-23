import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

import { harmonyLifecycleChannel } from '../runtime/HarmonyLifecycleChannel';

const DOMAIN = 0x0000;
const TAG = 'OpenChamberHarmony';

export default class EntryAbility extends UIAbility {
  onForeground(): void {
    harmonyLifecycleChannel.setActive(true);
  }

  onBackground(): void {
    harmonyLifecycleChannel.setActive(false);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code !== 0) {
        hilog.error(DOMAIN, TAG, 'Failed to load the packaged OpenChamber MobileApp');
      }
    });
  }
}

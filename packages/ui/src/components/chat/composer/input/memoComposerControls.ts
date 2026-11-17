import React from 'react';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { ModelControls } from '../../ModelControls';
import { MobileAgentButton } from '../../MobileAgentButton';
import { MobileModelButton } from '../../MobileModelButton';
import { MobileEffortButton } from '../../MobileEffortButton';

export const MemoModelControls: React.NamedExoticComponent<React.ComponentProps<typeof ModelControls>> = React.memo(ModelControls);
export const MemoComposerDictation: React.NamedExoticComponent<React.ComponentProps<typeof ComposerDictation>> = React.memo(ComposerDictation);
export const MemoMobileAgentButton: React.NamedExoticComponent<React.ComponentProps<typeof MobileAgentButton>> = React.memo(MobileAgentButton);
export const MemoMobileModelButton: React.NamedExoticComponent<React.ComponentProps<typeof MobileModelButton>> = React.memo(MobileModelButton);
export const MemoMobileEffortButton: React.NamedExoticComponent<React.ComponentProps<typeof MobileEffortButton>> = React.memo(MobileEffortButton);

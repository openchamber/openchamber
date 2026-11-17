import { create } from 'zustand';

export const useMobileChatInsets = create<{ left: number; right: number }>(() => ({ left: 0, right: 0 }));

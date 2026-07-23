import { useEffect } from 'react';
import { useMessengerStore } from '@/stores/useMessengerStore';

const FAST_INTERVAL_MS = 5_000;
const SLOW_INTERVAL_MS = 15_000;
/** First minute polls fast while the user is mid-invite, then backs off. */
const FAST_ATTEMPTS = 12;

/**
 * Polls Discord guild membership while `active` (invite step / empty server
 * list visible) so authorizing the bot updates the UI without a manual
 * refresh. Starts at 5s, backs off to 15s after about a minute, and keeps
 * polling until inactive or unmounted — there is no hard give-up, because the
 * user can take arbitrarily long to complete the Discord authorize screen.
 *
 * Callers pass `active = !hasGuilds && hasToken` (plus any step gating), so
 * the first authoritative guild list stops the loop via React re-render.
 */
export function useDiscordGuildMembershipPoll(active: boolean) {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const schedule = () => {
      if (cancelled) return;
      const delay = attempts <= FAST_ATTEMPTS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      if (cancelled) return;
      // Never overlap with an in-flight refresh (manual Refresh button,
      // resync, or the other poll consumer).
      if (useMessengerStore.getState().discordGuildsRefreshing) {
        schedule();
        return;
      }
      attempts += 1;
      await useMessengerStore.getState().refreshDiscordGuilds();
      schedule();
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
}

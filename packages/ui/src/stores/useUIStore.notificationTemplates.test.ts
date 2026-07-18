import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const initialTemplates = useUIStore.getState().notificationTemplates;

afterEach(() => {
  useUIStore.setState({ notificationTemplates: initialTemplates });
});

describe('useUIStore notification templates', () => {
  test('preserves rapid updates to separate template fields', () => {
    const { setNotificationTemplates } = useUIStore.getState();

    setNotificationTemplates((current) => ({
      ...current,
      completion: { ...current.completion, title: 'Completed' },
    }));
    setNotificationTemplates((current) => ({
      ...current,
      error: { ...current.error, message: 'Failed' },
    }));

    expect(useUIStore.getState().notificationTemplates).toEqual({
      ...initialTemplates,
      completion: { ...initialTemplates.completion, title: 'Completed' },
      error: { ...initialTemplates.error, message: 'Failed' },
    });
  });
});

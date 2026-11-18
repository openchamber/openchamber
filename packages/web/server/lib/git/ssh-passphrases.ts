import type { CredentialSource } from '../opencode/auth.js';

const INTEGRATION_ID = 'openchamber-git-ssh';

export function createSshPassphraseStore(source: Required<Pick<CredentialSource, 'create' | 'list' | 'remove'>>) {
  return {
    create: async (id: string, passphrase: string) => {
      await source.create({ id, integrationID: INTEGRATION_ID, label: 'Git SSH key',
        value: { type: 'key', key: passphrase }, activate: false });
    },
    read: async (id: string) => {
      const entry = (await source.list()).find((item) => item.id === id && item.integrationID === INTEGRATION_ID);
      if (!entry || entry.value.type !== 'key') return null;
      return entry.value.key;
    },
    remove: async (id: string) => {
      const entry = (await source.list()).find((item) => item.id === id && item.integrationID === INTEGRATION_ID);
      if (entry) await source.remove(id);
    },
  };
}

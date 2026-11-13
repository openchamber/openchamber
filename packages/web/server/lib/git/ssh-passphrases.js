const INTEGRATION_ID = 'openchamber-git-ssh';

/** Passphrases belong to exact credential IDs, independently of OpenCode's active account. */
export function createSshPassphraseStore(source) {
  return {
    create: async (id, passphrase) => {
      await source.create({ id, integrationID: INTEGRATION_ID, label: 'Git SSH key',
        value: { type: 'key', key: passphrase }, activate: false });
    },
    read: async (id) => {
      const entry = (await source.list()).find((item) => item.id === id && item.integrationID === INTEGRATION_ID);
      if (!entry || entry.value.type !== 'key') return null;
      return entry.value.key;
    },
    remove: async (id) => {
      const entry = (await source.list()).find((item) => item.id === id && item.integrationID === INTEGRATION_ID);
      if (entry) await source.remove(id);
    },
  };
}

import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { getMultiRunIdentity, isFusionSource, type MultiRunIdentity } from './identity';

export type FusionSource = {
  session: Session;
  directory: string | null;
  projectDirectory: string | null;
  identity: MultiRunIdentity;
};

/** Revalidate selected IDs before reading their output. A failed read is not an empty result. */
export async function loadFusionOutputs(
  client: OpencodeClient,
  sources: FusionSource[],
  anchor: MultiRunIdentity,
  assertCurrent: () => void,
): Promise<Array<{ source: FusionSource; text: string }>> {
  const outputs = await Promise.all(sources.map(async (source) => {
    assertCurrent();
    const directory = source.directory ?? source.session.directory;
    const current = await client.session.get({ sessionID: source.session.id, directory }, { throwOnError: true });
    assertCurrent();
    if (!current.data || !isFusionSource(anchor, getMultiRunIdentity(current.data, source.projectDirectory ?? current.data.directory))) {
      throw new Error('Fusion source membership changed');
    }
    const result = await client.session.messages({ sessionID: source.session.id, directory, limit: 50 }, { throwOnError: true });
    assertCurrent();
    if (!result.data) throw new Error('Fusion source messages unavailable');
    let text = '';
    for (let index = result.data.length - 1; index >= 0; index -= 1) {
      const record = result.data[index];
      if (record.info.role !== 'assistant') continue;
      text = flattenAssistantTextParts(record.parts).trim();
      break;
    }
    return { source: { ...source, session: current.data }, text };
  }));
  assertCurrent();
  return outputs.filter((output) => output.text.length > 0);
}

import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
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
  sources: FusionSource[],
  anchor: MultiRunIdentity,
  assertCurrent: () => void,
): Promise<Array<{ source: FusionSource; text: string }>> {
  const outputs = await Promise.all(sources.map(async (source) => {
    assertCurrent();
    const directory = source.directory ?? source.session.directory;
    const current = await opencodeClient.getSession(source.session.id, directory);
    assertCurrent();
    if (!isFusionSource(anchor, getMultiRunIdentity(current, source.projectDirectory ?? current.directory))) {
      throw new Error('Fusion source membership changed');
    }
    const page = await opencodeClient.getSessionMessages(source.session.id, { limit: 50 }, directory);
    assertCurrent();
    let text = '';
    // v2 pages messages newest first, so the first assistant record is the last reply.
    for (const record of page.items) {
      if (record.info.role !== 'assistant') continue;
      text = flattenAssistantTextParts(record.parts).trim();
      break;
    }
    return { source: { ...source, session: current }, text };
  }));
  assertCurrent();
  return outputs.filter((output) => output.text.length > 0);
}

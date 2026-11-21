import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { type useFileDocument } from './useFileDocument';

export function useFileReadAloud({ fileDocument }: {
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent'>;
}) {
  const { fileContent } = fileDocument;
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const toggleTTS = () => {
      if (isTTSPlaying) {
        stopTTS();
      } else if (fileContent.trim()) {
        void playTTS(fileContent);
      }
    };

  return { isTTSPlaying, showMessageTTSButtons, toggleTTS };
}

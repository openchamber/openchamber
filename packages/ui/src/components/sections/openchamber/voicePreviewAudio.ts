export const disposePreviewAudio = (audio: HTMLAudioElement | null | undefined) => {
    if (!audio) return;

    audio.onended = null;
    audio.onerror = null;
    audio.pause();

    const { src } = audio;
    if (src.startsWith('blob:')) {
        URL.revokeObjectURL(src);
    }

    audio.removeAttribute('src');
    audio.load();
};

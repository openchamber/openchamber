export const disposePreviewAudio = (audio: HTMLAudioElement | null | undefined) => {
    if (!audio) return;

    audio.pause();

    const { src } = audio;
    if (src.startsWith('blob:')) {
        URL.revokeObjectURL(src);
    }

    audio.removeAttribute('src');
};

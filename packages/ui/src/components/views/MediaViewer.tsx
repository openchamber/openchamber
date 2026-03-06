import React from 'react';

import { cn } from '@/lib/utils';

export type MediaCategory = 'pdf' | 'audio' | 'video';

export type MediaViewerProps = {
  /** The type of media to render */
  category: MediaCategory;
  /** The source URL for the media */
  src: string;
  /** The file name to display (used for audio) */
  fileName: string;
  /** Whether to use fullscreen styling (default: false) */
  fullscreen?: boolean;
};

/**
 * MediaViewer - A reusable component for rendering PDF, audio, and video content.
 *
 * Handles three media types:
 * - PDF: Uses an object tag with a fallback link
 * - Audio: Uses HTML5 audio element with file name display
 * - Video: Uses HTML5 video element
 *
 * Supports both normal and fullscreen display modes with appropriate styling.
 */
export const MediaViewer: React.FC<MediaViewerProps> = ({
  category,
  src,
  fileName,
  fullscreen = false,
}) => {
  const padding = fullscreen ? 'p-4' : 'p-3';

  if (category === 'pdf') {
    return (
      <div className={cn('flex h-full w-full', padding)}>
        <object
          data={src}
          type="application/pdf"
          className="w-full h-full rounded-md border border-border/30"
        >
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="mb-2">Unable to display PDF in this browser.</p>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Open PDF in new tab
            </a>
          </div>
        </object>
      </div>
    );
  }

  if (category === 'audio') {
    return (
      <div className={cn('flex h-full items-center justify-center', padding)}>
        <div className="w-full max-w-md flex flex-col items-center gap-4">
          <div className="text-sm text-muted-foreground">{fileName}</div>
          <audio
            src={src}
            controls
            preload="metadata"
            className="w-full"
            controlsList="nodownload"
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      </div>
    );
  }

  if (category === 'video') {
    const videoClassName = fullscreen
      ? 'max-w-full max-h-full rounded-md border border-border/30 bg-black'
      : 'max-w-full max-h-[70vh] rounded-md border border-border/30 bg-black';

    return (
      <div className={cn('flex h-full items-center justify-center', padding)}>
        <video
          src={src}
          controls
          preload="metadata"
          className={videoClassName}
          controlsList="nodownload"
        >
          Your browser does not support the video element.
        </video>
      </div>
    );
  }

  return null;
};

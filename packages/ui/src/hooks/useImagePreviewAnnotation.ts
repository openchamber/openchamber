import React from 'react';

export function useImagePreviewAnnotation(open: boolean, imageUrl: string | undefined) {
    const [annotating, setAnnotating] = React.useState(false);

    React.useEffect(() => {
        if (!open) setAnnotating(false);
    }, [open]);

    React.useEffect(() => {
        setAnnotating(false);
    }, [imageUrl]);

    return { annotating, setAnnotating };
}
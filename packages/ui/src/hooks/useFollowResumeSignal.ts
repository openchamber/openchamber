import React from 'react';

export const useFollowResumeSignal = (resumeRef: React.MutableRefObject<boolean>, following: () => boolean): void => {
    const hiddenRef = React.useRef(false);
    const followingRef = React.useRef(following);
    followingRef.current = following;
    React.useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                hiddenRef.current = followingRef.current();
                resumeRef.current = false;
                return;
            }
            if (document.visibilityState !== 'visible' || !hiddenRef.current) return;
            hiddenRef.current = false;
            resumeRef.current = true;
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [resumeRef]);
};

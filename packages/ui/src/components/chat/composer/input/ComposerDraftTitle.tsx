import React from 'react';
import { DraftProjectName } from '@/components/chat/DraftProjectName';

export const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <DraftProjectName label={projectLabel} />
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

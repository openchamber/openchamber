import React from 'react';

type FormDockMode = 'dock' | 'reading' | 'in-chat';

export const FormDockModeContext = React.createContext<FormDockMode>('dock');

export const resolveFormDockMode = (formsInChat: boolean, readingHistory: boolean): FormDockMode => {
    if (formsInChat) return 'in-chat';
    return readingHistory ? 'reading' : 'dock';
};

export const formWaitingBlockId = (form: { id: string; sessionID: string }): string => `${form.sessionID}/${form.id}`;

export const resolveFormsInChat = ({ questionsInChat, pinned, transcriptShown }: {
    questionsInChat: boolean;
    pinned: boolean;
    transcriptShown: boolean;
}): boolean => questionsInChat && !pinned && transcriptShown;

import React from 'react';
import { useRecoveredQuestions, useScopedBlockingForms } from '@/sync/sync-context';
import { dispatchPageWaiting } from './lib/scroll/timelineScrollIntent';
import { FormCard } from './FormCard';

/**
 * The questions waiting in this chat, drawn as cards at its end when
 * questions are set to show in the chat. Same forms as the dock would show
 * (the session's subtree, then the directory's location-scoped ones, then
 * questions whose turn died), all of them, in order.
 */
export const TranscriptForms: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => {
    const forms = useScopedBlockingForms(sessionId, directory);
    const recovered = useRecoveredQuestions(sessionId, directory);
    return (
        <>
            {forms.map((form) => (
                <WaitingBlock key={form.id} id={form.id}>
                    <FormCard form={form} inChat directory={directory} />
                </WaitingBlock>
            ))}
            {recovered.map((question) => (
                <WaitingBlock key={question.form.id} id={question.form.id}>
                    <FormCard form={question.form} recovered={question} inChat directory={directory} />
                </WaitingBlock>
            ))}
        </>
    );
};

/**
 * A waiting block (`data-waiting-page`, named by the form id): the timeline
 * brings it into view once when it appears, for a reader who follows the end,
 * and the dock's line or a toast can ask for it by id.
 */
const WaitingBlock: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        dispatchPageWaiting(ref.current);
    }, [id]);
    return <div ref={ref} data-waiting-page={id}>{children}</div>;
};

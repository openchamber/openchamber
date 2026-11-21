import React from 'react';
import { useRecoveredQuestions, useScopedBlockingForms } from '@/sync/sync-context';
import { dispatchPageWaiting } from './lib/scroll/timelineScrollIntent';
import { FormCard } from './FormCard';
import { formWaitingBlockId } from './formsInChat';

export const TranscriptForms: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => {
    const forms = useScopedBlockingForms(sessionId, directory);
    const recovered = useRecoveredQuestions(sessionId, directory);
    return (
        <>
            {forms.map((form) => (
                <WaitingBlock key={formWaitingBlockId(form)} id={formWaitingBlockId(form)}>
                    <FormCard form={form} inChat directory={directory} />
                </WaitingBlock>
            ))}
            {recovered.map((question) => (
                <WaitingBlock key={formWaitingBlockId(question.form)} id={formWaitingBlockId(question.form)}>
                    <FormCard form={question.form} recovered={question} inChat directory={directory} />
                </WaitingBlock>
            ))}
        </>
    );
};

const WaitingBlock: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        dispatchPageWaiting(ref.current);
    }, [id]);
    return <div ref={ref} data-waiting-page={id}>{children}</div>;
};

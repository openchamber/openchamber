import React from 'react';
import { useRecoveredQuestions, useScopedBlockingForms } from '@/sync/sync-context';
import { dispatchPageWaiting } from './lib/scroll/timelineScrollIntent';
import { FormCard } from './FormCard';

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

const WaitingBlock: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    React.useEffect(() => {
        dispatchPageWaiting(ref.current);
    }, [id]);
    return <div ref={ref} data-waiting-page={id}>{children}</div>;
};

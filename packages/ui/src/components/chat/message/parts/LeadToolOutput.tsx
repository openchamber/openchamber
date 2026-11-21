import * as React from 'react';

import type { ToolInput } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { leadBriefReadSchema, leadBriefSavedSchema, leadDigestSavedSchema, readLeadBriefCall, type OpenChamberEnvelope } from './openChamberToolEnvelope';
import { RawToggleContext, usePanelsAvailable } from './toolResultContext';
import { Actions, Section, Warning } from './ToolResultParts';

const BriefText: React.FC<{ text: string }> = ({ text }) => (
    <div className="typography-meta line-clamp-[8] whitespace-pre-wrap break-words text-foreground">{text}</div>
);

const LeadBriefBody: React.FC<{ data: unknown; input: ToolInput | undefined; directory: string; isMobile: boolean }> = ({ data, input, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const saved = leadBriefSavedSchema.safeParse(data);
    const read = leadBriefReadSchema.safeParse(data);
    const call = readLeadBriefCall(input);
    const file = saved.data?.file ?? read.data?.file;
    const size = saved.data ?? (read.data && !read.data.empty ? { length: read.data.brief.trim().length, limit: read.data.limit } : null);
    const brief = saved.success ? call.brief : read.data?.brief;
    return (
        <>
            {read.data?.empty ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.lead.briefEmpty')}</div> : null}
            {saved.success && call.edits.length > 0 ? call.edits.map((edit, index) => (
                <div key={index} className="min-w-0 space-y-0.5">
                    <div className="typography-meta line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground line-through">{edit.find}</div>
                    {edit.replace ? <div className="typography-meta line-clamp-4 whitespace-pre-wrap break-words text-foreground">{edit.replace}</div> : null}
                </div>
            )) : brief?.trim() ? <BriefText text={brief.trim()} /> : null}
            {size ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.lead.briefSize', { length: String(size.length), limit: String(size.limit) })}</div> : null}
            <Actions open={panels && file && directory ? { label: t('chat.toolPart.openchamber.open.brief'), icon: 'file-text', onOpen: () => useUIStore.getState().openContextFile(directory, file) } : null} />
        </>
    );
};

const DigestLines: React.FC<{ label: string; items: string[] }> = ({ label, items }) => (
    items.length === 0 ? null : (
        <Section label={label}>
            <ul className="min-w-0 space-y-0.5">
                {items.map((item) => <li key={item} className="typography-meta break-words text-foreground">{item}</li>)}
            </ul>
        </Section>
    )
);

const LeadDigestBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = leadDigestSavedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { digest, droppedFromSuggestions } = parsed.data;
    return (
        <>
            {digest.needsYou.length > 0 ? (
                <Section label={t('chat.leadDigest.needsYou')}>
                    <ul className="min-w-0 space-y-1">
                        {digest.needsYou.map(({ question, options, recommended }) => (
                            <li key={question} className="min-w-0 typography-meta">
                                <div className="break-words text-foreground">{question}</div>
                                {options.length > 0 ? (
                                    <div className="break-words text-muted-foreground">
                                        {options.map((option) => (option === recommended ? `${option} (${t('chat.leadDigest.recommended')})` : option)).join(' · ')}
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </Section>
            ) : null}
            <DigestLines label={t('chat.leadDigest.suggestions')} items={digest.suggestions} />
            <DigestLines label={t('chat.leadDigest.news')} items={digest.news} />
            <DigestLines label={t('chat.leadDigest.now')} items={digest.now} />
            <Warning text={droppedFromSuggestions.length > 0 ? t('chat.toolPart.openchamber.lead.dropped', { items: droppedFromSuggestions.join('; ') }) : undefined} />
            <Actions />
        </>
    );
};

export const LeadToolOutput: React.FC<{
    envelope: OpenChamberEnvelope;
    input: ToolInput | undefined;
    directory: string;
    isMobile: boolean;
    rawToggle: React.ReactNode;
}> = ({ envelope, input, directory, isMobile, rawToggle }) => (
    <RawToggleContext.Provider value={rawToggle}>
        {envelope.action === 'lead.brief'
            ? <LeadBriefBody data={envelope.data} input={input} directory={directory} isMobile={isMobile} />
            : <LeadDigestBody data={envelope.data} />}
    </RawToggleContext.Provider>
);

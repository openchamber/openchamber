import React from 'react';
import { RiAiAgentLine, RiBrainAi3Line, RiUser3Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';
import { getAgentColor } from '@/lib/agentColors';
import { useProviderLogo } from '@/hooks/useProviderLogo';

interface MessageHeaderProps {
    isUser: boolean;
    providerID: string | null;
    agentName: string | undefined;
    modelName: string | undefined;
    variant?: string;
    isDarkTheme: boolean;
}

const MessageHeader: React.FC<MessageHeaderProps> = ({ isUser, providerID, agentName, modelName, variant, isDarkTheme }) => {
    const { src: logoSrc, onError: handleLogoError, hasLogo } = useProviderLogo(providerID);

    return (
        <div className={cn('mb-2')}>
            <div className={cn('flex items-center justify-between gap-2')}>
                <div className="flex items-center gap-2">
                    <div className="flex-shrink-0">
                        {isUser ? (
                            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                                <RiUser3Line className="h-4 w-4 text-primary" />
                            </div>
                        ) : (
                            <div className="flex items-center justify-center">
                                {hasLogo && logoSrc ? (
                                    <img
                                        src={logoSrc}
                                        alt={`${providerID} logo`}
                                        className="h-4 w-4"
                                        style={{
                                            filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
                                        }}
                                        onError={handleLogoError}
                                    />
                                ) : (
                                    <RiBrainAi3Line
                                        className="h-4 w-4"
                                        style={{ color: `var(${getAgentColor(agentName).var})` }}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <h3
                            className={cn(
                                'font-bold typography-ui-header tracking-tight leading-none',
                                isUser ? 'text-primary' : 'text-foreground'
                            )}
                        >
                            {isUser ? m.chatYou() : (modelName || m.chatAssistant())}
                        </h3>
                        {!isUser && agentName && (
                            <div
                                className={cn(
                                    'flex items-center gap-1 px-1.5 py-0 rounded cursor-default',
                                    'agent-badge typography-meta',
                                    'hover:bg-[rgb(from_var(--agent-color-bg)_r_g_b_/_0.1)] hover:border-[rgb(from_var(--agent-color)_r_g_b_/_0.2)]',
                                    getAgentColor(agentName).class
                                )}
                            >
                                <RiAiAgentLine className="h-3 w-3 flex-shrink-0" />
                                <span className="font-medium">{agentName}</span>
                            </div>
                        )}
                        {!isUser && variant && (
                            <div
                                className={cn(
                                    'flex items-center gap-1 px-1.5 py-0 rounded cursor-default',
                                    'agent-badge typography-meta',
                                    'hover:bg-[rgb(from_var(--agent-color-bg)_r_g_b_/_0.1)] hover:border-[rgb(from_var(--agent-color)_r_g_b_/_0.2)]',
                                    variant === 'Default' ? undefined : 'agent-info'
                                )}
                                style={
                                    variant === 'Default'
                                        ? ({
                                              '--agent-color': 'var(--muted-foreground)',
                                              '--agent-color-bg': 'var(--muted-foreground)',
                                          } as React.CSSProperties)
                                        : undefined
                                }
                            >
                                <RiBrainAi3Line className="h-3 w-3 flex-shrink-0" />
                                <span className="font-medium">{variant.length > 0 ? variant[0].toLowerCase() + variant.slice(1) : variant}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MessageHeader);

import React from 'react';
import type { MessageBodyProps } from './body/messageBodyProps';
import { UserMessageBody } from './body/UserMessageBody';
import { AssistantMessageBody } from './body/AssistantMessageBody';

export type { MessageExtraAction } from './body/messageBodyProps';

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

    if (isUser) {
        return (
            <UserMessageBody
                parts={props.parts}
                messageCreatedAt={props.messageCreatedAt}
                isMobile={props.isMobile}
                alwaysShowActions={props.alwaysShowActions}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onSaveAsSnippet={props.onSaveAsSnippet}
                onSelectMessages={props.onSelectMessages}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                onRevert={props.onRevert}
                onFork={props.onFork}
                contextPinned={props.contextPinned}
                contextPinPending={props.contextPinPending}
                onToggleContextPin={props.onToggleContextPin}
                userMessagePart={props.userMessagePart}
                extraActions={props.extraActions}
                promptOrigin={props.promptOrigin}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;

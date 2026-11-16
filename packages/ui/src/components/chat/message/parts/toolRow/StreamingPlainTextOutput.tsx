import React from 'react';
import { TOOL_COLLAPSED_CUSTOM_STYLE } from './toolRowStyles';
import { getStreamingOutputAppend } from '../toolOutput';

export const StreamingPlainTextOutput: React.FC<{ output: string }> = ({ output }) => {
    const preRef = React.useRef<HTMLPreElement>(null);
    const previousOutputRef = React.useRef('');

    React.useLayoutEffect(() => {
        const element = preRef.current;
        if (!element) {
            return;
        }

        const firstChild = element.firstChild;
        const textNode = firstChild instanceof globalThis.Text
            ? firstChild
            : document.createTextNode('');
        if (textNode !== firstChild) {
            element.replaceChildren(textNode);
        }

        const append = getStreamingOutputAppend(previousOutputRef.current, output);
        if (append === undefined) {
            textNode.data = output;
        } else if (append.length > 0) {
            textNode.appendData(append);
        }
        previousOutputRef.current = output;
    }, [output]);

    return (
        <pre
            ref={preRef}
            className="m-0 whitespace-pre-wrap break-words"
            style={{
                ...TOOL_COLLAPSED_CUSTOM_STYLE,
                lineHeight: 'round(var(--code-block-line-height), 1px)',
                overflowWrap: 'break-word',
            }}
        />
    );
};

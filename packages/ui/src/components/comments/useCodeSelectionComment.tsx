import React from 'react';

import { CodeSelectionComments } from './codeSelectionComments';
import { CodeSelectionCommentMenu } from './CodeSelectionCommentMenu';

export function useCodeSelectionComment({ filePath, scope }: { filePath: string | null; scope: string }) {
  const [comments] = React.useState(() => new CodeSelectionComments());
  return {
    extension: comments.extension,
    menu: <CodeSelectionCommentMenu key={scope} comments={comments} filePath={filePath} />,
  };
}

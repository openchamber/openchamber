import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { GitIdentityProfile } from '@/lib/api/types';
import { isCompleteIdentity } from '@/lib/api/git-identity';
import { activeIdentityFor, identityAccountConnected, selectableIdentities } from '@/lib/source-control/identity';
import { isSignatureOnlyIdentity } from '@/lib/source-control/applyIdentity';

// Execute the component's actual author callbacks without mocking React or exporting UI internals.
const readAuthorCallback = (file: URL, name: string): string => {
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): ts.ArrowFunction | undefined => {
    let call: ts.CallExpression | undefined;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      call = node.initializer;
    } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const expression = node.expression;
      const dependencies = expression.arguments[1];
      if (expression.expression.getText(source) === 'React.useEffect'
        && dependencies && ts.isArrayLiteralExpression(dependencies)
        && dependencies.elements.some((dependency) => ts.isIdentifier(dependency) && dependency.text === name)) {
        call = expression;
      }
    }
    if (call?.arguments[0] && ts.isArrowFunction(call.arguments[0])) return call.arguments[0];
    return ts.forEachChild(node, visit);
  };
  const callback = visit(source);
  if (!callback) throw new Error(`Author callback not found: ${name}`);
  return ts.transpileModule(`(${callback.getText(source)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
};

const availableAuthors = readAuthorCallback(new URL('./GitView.tsx', import.meta.url), 'availableIdentities');
const activeAuthor = readAuthorCallback(new URL('./GitView.tsx', import.meta.url), 'activeIdentityProfile');

const globalIdentity: GitIdentityProfile = { id: 'global', name: 'Global', userName: 'Global Author', userEmail: 'global@example.com' };
const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' } as const;
const work: GitIdentityProfile = { id: 'work', name: 'Work', userName: 'Work Author', userEmail: 'work@example.com', account, transport: 'account' };
const signed: GitIdentityProfile = {
  id: 'signed', name: 'Signed author', userName: 'Signed Author', userEmail: 'signed@example.com',
  account, transport: 'account', signCommits: true, signingKey: '/public/signing.pub',
};
const plain: GitIdentityProfile = { id: 'plain', name: 'Author', userName: 'Plain Author', userEmail: 'plain@example.com', account, transport: 'account' };
const incomplete: GitIdentityProfile = { id: 'legacy', name: 'Legacy', userName: 'Legacy Author', userEmail: 'legacy@example.com' };
// The callback also asks whether the identity's account is still connected;
// an instance that has not been read answers null, which keeps it offered.
const helpers = { selectableIdentities, isCompleteIdentity, isSignatureOnlyIdentity, identityAccountConnected, activeIdentityFor, connectedAccountIds: () => null };
const profiles = [work, signed, plain];

// The clone screen no longer chooses an author on its own: it proposes one
// identity, which carries the author with it, and `proposeIdentityForHost`
// owns that rule and its tests.
describe('Git view authors', () => {
  test('offers every author for unrelated HTTPS, SSH, and absent remotes', () => {
    expect(runInNewContext(availableAuthors, { profiles, globalIdentity, ...helpers })).toEqual([globalIdentity, ...profiles]);
  });

  test('retains ID deduplication, ordering, and stored signing data', () => {
    expect(runInNewContext(availableAuthors, { profiles: [signed, work, signed], globalIdentity, ...helpers }))
      .toEqual([globalIdentity, signed, work]);
    expect(runInNewContext(availableAuthors, { profiles: [signed], globalIdentity: null, ...helpers })[0]).toBe(signed);
    // An identity from an earlier release is a signature, and still offered.
    expect(runInNewContext(availableAuthors, { profiles: [incomplete, work], globalIdentity: null, ...helpers }))
      .toEqual([incomplete, work]);
  });

  test('prefers a matching stored author over a matching global author and preserves signing', () => {
    expect(runInNewContext(activeAuthor, { ...helpers,
      profiles, globalIdentity: { ...globalIdentity, userName: signed.userName, userEmail: signed.userEmail },
      currentIdentity: { userName: signed.userName, userEmail: signed.userEmail },
    })).toBe(signed);
  });

  test('uses the matching global author when no stored author matches', () => {
    expect(runInNewContext(activeAuthor, { ...helpers,
      profiles, globalIdentity, currentIdentity: { userName: globalIdentity.userName, userEmail: globalIdentity.userEmail },
    })).toBe(globalIdentity);
  });

  test('derives a local author from name and email without transport fields', () => {
    expect(runInNewContext(activeAuthor, { ...helpers,
      profiles, globalIdentity, currentIdentity: { userName: 'Local Author', userEmail: 'local@example.com' },
    })).toEqual({
      id: 'local-config', name: 'Local Author', userName: 'Local Author', userEmail: 'local@example.com', color: 'info', icon: 'user',
    });
  });

  test('preserves the global fallback when current author data is absent or incomplete', () => {
    for (const currentIdentity of [null, { userName: 'Incomplete', userEmail: null }]) {
      expect(runInNewContext(activeAuthor, { ...helpers,
 profiles, globalIdentity, currentIdentity })).toBe(globalIdentity);
    }
    expect(runInNewContext(activeAuthor, { ...helpers,
 profiles: [], globalIdentity: null, currentIdentity: null })).toBeNull();
  });
});

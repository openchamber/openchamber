import fs from 'node:fs';
import ts from 'typescript';

// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it, mock } from 'bun:test';

import {
  GIT_INTERNAL_OPERATION_CLASSIFICATION,
  GIT_NETWORK_USAGE,
  GIT_OPERATION_PROFILE,
  GIT_RUNTIME_OWNER_CLASSIFICATION,
  GIT_RUNTIME_OWNER_KIND,
  GIT_SERVICE_OPERATION_CLASSIFICATION,
  getGitOperationClassification,
  getGitServiceOperationClassification,
} from './git-operation-classification';

const readSource = (relativePath: string): string => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: { fs: { readFile: async () => new Uint8Array() } },
}));

const runtimeGitService = await import('./gitService');

const runtimeExportedServiceOperations = (): string[] => Object.keys(runtimeGitService)
  .filter((name) => typeof runtimeGitService[name as keyof typeof runtimeGitService] === 'function')
  .sort();

type ParsedSource = {
  name: string;
  source: string;
  sourceFile: ts.SourceFile;
};

const parsedSourceFiles = (): ParsedSource[] => fs.readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'))
  .map((entry) => {
    const source = readSource(`./${entry.name}`);
    return {
      name: entry.name,
      source,
      sourceFile: ts.createSourceFile(entry.name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    };
  });

const importedBindings = (
  sourceFile: ts.SourceFile,
  moduleNames: ReadonlySet<string>,
  importedName: string,
): { identifiers: Set<string>; namespaces: Set<string> } => {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!moduleNames.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === importedName) identifiers.add(element.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { identifiers, namespaces };
};

const isBoundCall = (
  expression: ts.LeftHandSideExpression,
  bindings: { identifiers: Set<string>; namespaces: Set<string> },
  propertyName: string,
): boolean => (
  (ts.isIdentifier(expression) && bindings.identifiers.has(expression.text))
  || (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && bindings.namespaces.has(expression.expression.text)
    && expression.name.text === propertyName
  )
);

const hasDirectGitProcessCall = ({ sourceFile }: ParsedSource): boolean => {
  const childProcessModules = new Set(['child_process', 'node:child_process']);
  const utilModules = new Set(['util', 'node:util']);
  const spawnBindings = importedBindings(sourceFile, childProcessModules, 'spawn');
  const execFileBindings = importedBindings(sourceFile, childProcessModules, 'execFile');
  const promisifyBindings = importedBindings(sourceFile, utilModules, 'promisify');
  const variableInitializers = new Map<string, ts.Expression>();
  const promisifiedExecFiles = new Set<string>();

  const collectVariables = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer);
      if (
        ts.isCallExpression(node.initializer)
        && isBoundCall(node.initializer.expression, promisifyBindings, 'promisify')
        && node.initializer.arguments[0]
        && (
          (ts.isIdentifier(node.initializer.arguments[0]) && execFileBindings.identifiers.has(node.initializer.arguments[0].text))
          || (
            ts.isPropertyAccessExpression(node.initializer.arguments[0])
            && ts.isIdentifier(node.initializer.arguments[0].expression)
            && execFileBindings.namespaces.has(node.initializer.arguments[0].expression.text)
            && node.initializer.arguments[0].name.text === 'execFile'
          )
        )
      ) {
        promisifiedExecFiles.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(sourceFile);

  const resolvesToGit = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isStringLiteralLike(expression)) return expression.text === 'git';
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return false;
      const initializer = variableInitializers.get(expression.text);
      if (!initializer) return false;
      seen.add(expression.text);
      return resolvesToGit(initializer, seen);
    }
    let found = false;
    ts.forEachChild(expression, (child) => {
      if (!found && ts.isExpression(child) && resolvesToGit(child, new Set(seen))) found = true;
    });
    return found;
  };

  let found = false;
  const visitCalls = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && node.arguments[0] && resolvesToGit(node.arguments[0])) {
      const directSpawn = isBoundCall(node.expression, spawnBindings, 'spawn');
      const directExecFile = isBoundCall(node.expression, execFileBindings, 'execFile');
      const promisifiedExecFile = ts.isIdentifier(node.expression) && promisifiedExecFiles.has(node.expression.text);
      if (directSpawn || directExecFile || promisifiedExecFile) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sourceFile);
  return found;
};

const importsGitServiceCore = ({ sourceFile }: ParsedSource): boolean => {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === './gitService'
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node)
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === './gitService'
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

describe('VS Code Git operation classification', () => {
  it('classifies every semantically imported runtime function export exactly once', () => {
    expect(Object.keys(GIT_SERVICE_OPERATION_CLASSIFICATION).sort()).toEqual(runtimeExportedServiceOperations());
  });

  it('uses only closed immutable profile and network values', () => {
    const profiles = new Set(Object.values(GIT_OPERATION_PROFILE));
    const networkValues = new Set(Object.values(GIT_NETWORK_USAGE));
    expect(Object.isFrozen(GIT_SERVICE_OPERATION_CLASSIFICATION)).toBe(true);
    for (const classification of Object.values(GIT_SERVICE_OPERATION_CLASSIFICATION)) {
      expect(Object.isFrozen(classification)).toBe(true);
      expect(profiles.has(classification.profile)).toBe(true);
      expect(networkValues.has(classification.network)).toBe(true);
    }
  });

  it('makes built-in/raw compounds, topology, network, bootstrap, and memory ownership explicit', () => {
    expect(getGitServiceOperationClassification('getGitStatus')).toEqual({
      profile: GIT_OPERATION_PROFILE.READ,
      network: GIT_NETWORK_USAGE.NONE,
    });
    expect(getGitServiceOperationClassification('createGitCommit').profile)
      .toBe(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE);
    expect(getGitServiceOperationClassification('createWorktree').profile)
      .toBe(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE);
    expect(getGitServiceOperationClassification('gitFetch').network).toBe(GIT_NETWORK_USAGE.REQUIRED);
    expect(getGitServiceOperationClassification('checkIsGitRepository').profile).toBe(GIT_OPERATION_PROFILE.BOOTSTRAP);
    expect(getGitServiceOperationClassification('getWorktreeBootstrapStatus').profile).toBe(GIT_OPERATION_PROFILE.MEMORY);
    expect(GIT_INTERNAL_OPERATION_CLASSIFICATION.worktreeAttachment.profile).toBe(GIT_OPERATION_PROFILE.TOPOLOGY_WRITE);
    expect(getGitOperationClassification('worktreeBootstrap').profile).toBe(GIT_OPERATION_PROFILE.COMMON_WORKTREE_WRITE);
    expect(() => getGitServiceOperationClassification('futureOperation')).toThrow('Unclassified Git service operation');
  });
});

describe('VS Code direct Git owner inventory', () => {
  it('keeps classified owners and intentional bypasses closed and immutable', () => {
    expect(Object.keys(GIT_RUNTIME_OWNER_CLASSIFICATION).sort()).toEqual([
      'external-git-processes',
      'fs/exec',
      'fs/list-check-ignore',
      'fs/search-check-ignore',
      'git/conflict-details',
      'git/context-discovery',
      'git/hooks-and-helpers',
      'git/service-facade',
      'skills-catalog/clone-repository',
      'skills-catalog/git-version',
      'worktree/start-command',
    ]);
    expect(Object.isFrozen(GIT_RUNTIME_OWNER_CLASSIFICATION)).toBe(true);
    const kinds = new Set(Object.values(GIT_RUNTIME_OWNER_KIND));
    for (const classification of Object.values(GIT_RUNTIME_OWNER_CLASSIFICATION)) {
      expect(Object.isFrozen(classification)).toBe(true);
      expect(kinds.has(classification.kind)).toBe(true);
    }
  });

  it('routes every bridge owner through the facade/runtime and keeps raw primitives isolated', () => {
    const standardBridge = readSource('./bridge-git-runtime.ts');
    const specialBridge = readSource('./bridge-git-special-runtime.ts');
    const bridge = readSource('./bridge.ts');
    const fsHelpers = readSource('./bridge-fs-helpers-runtime.ts');
    const serviceFacade = readSource('./git-execution-service.ts');
    const serviceCore = readSource('./gitService.ts');
    const skillsCatalog = readSource('./skillsCatalog.ts');

    expect(standardBridge).toContain("from './git-execution-service'");
    expect(standardBridge).not.toContain("from './gitService'");
    expect(specialBridge).toContain('deps.withGitRawRead(directory');
    expect(specialBridge).not.toContain("from './gitService'");
    expect(bridge).toContain("from './git-execution-runtime'");
    expect(fsHelpers).toContain('runGitObservation(args, cwd)');
    expect(fsHelpers).not.toContain("from './bridge-git-process-runtime'");
    expect(serviceFacade).toContain('runtime.runServiceOperation(');
    expect(serviceFacade).toContain('(lease) => coreImpl.createWorktree(directory, input, {');
    expect(serviceFacade).toContain('scheduleBackground: createBackgroundScheduler(runtime, {');
    expect(serviceFacade).toContain('runWithGitExecutionScope(readOnly, task)');
    expect(serviceCore).toContain('env: { ...env, ...getGitExecutionEnv() }');
    expect(serviceCore).toContain("operation: 'worktreeAttachment'");
    expect(serviceCore).toContain("operation: 'worktreeBootstrap'");
    expect(skillsCatalog).toContain('execution.reserveClone(targetDir');
    expect(skillsCatalog).toContain('lease.releaseNetwork()');
  });

  it('uses the TypeScript AST to keep direct Git process construction in the three inventoried primitive owners', () => {
    const sourceFiles = parsedSourceFiles();
    const owners = sourceFiles
      .filter(hasDirectGitProcessCall)
      .map(({ name }) => name)
      .sort();

    expect(owners).toEqual([
      'bridge-git-process-runtime.ts',
      'gitService.ts',
      'skillsCatalog.ts',
    ]);

    const directServiceImporters = sourceFiles
      .filter(importsGitServiceCore)
      .map(({ name }) => name)
      .sort();
    expect(directServiceImporters).toEqual(['git-execution-service.ts']);
  });
});

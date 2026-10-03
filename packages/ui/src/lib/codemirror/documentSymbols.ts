import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, type syntaxTree } from '@codemirror/language';

// The parser's node type, reached through the editor package this module
// already depends on.
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

// The outline of the open file, read from the syntax tree the editor already
// keeps for indentation and folding. No language server: what a parser can
// name (functions, classes, types, headings) is listed; what needs type
// information (references, definitions in other files) is not.

export type DocumentSymbolKind = 'function' | 'method' | 'class' | 'type' | 'module' | 'heading';

export type DocumentSymbol = {
    name: string;
    kind: DocumentSymbolKind;
    /** 1-based line of the declaration. */
    line: number;
    /** Offset of the name, where the cursor lands. */
    from: number;
    /** Nesting for indentation: containing symbols, or a heading's level below 1. */
    depth: number;
};

// Node names across the bundled Lezer grammars (JS/TS, Python, Go, Rust).
const DECLARATION_KINDS = new Map<string, DocumentSymbolKind>(Object.entries({
    FunctionDeclaration: 'function',
    FunctionDefinition: 'function',
    FunctionItem: 'function',
    FunctionDecl: 'function',
    MethodDeclaration: 'method',
    MethodDecl: 'method',
    ClassDeclaration: 'class',
    ClassDefinition: 'class',
    InterfaceDeclaration: 'class',
    StructItem: 'class',
    TraitItem: 'class',
    ImplItem: 'class',
    TypeAliasDeclaration: 'type',
    EnumDeclaration: 'type',
    EnumItem: 'type',
    TypeSpec: 'type',
    ModItem: 'module',
} satisfies Record<string, DocumentSymbolKind>));

// `const foo = () => …` and `static bar = function () {…}` read as functions.
const BINDING_DECLARATIONS = new Map<string, DocumentSymbolKind>([
    ['VariableDeclaration', 'function'],
    ['PropertyDeclaration', 'method'],
]);
const FUNCTION_VALUES = new Set(['ArrowFunction', 'FunctionExpression']);

const NAME_NODES = new Set([
    'VariableDefinition',
    'PropertyDefinition',
    'TypeDefinition',
    'VariableName',
    'DefName',
    'FieldName',
    'BoundIdentifier',
    'TypeIdentifier',
]);

const HEADING_RE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

const childNamed = (node: SyntaxNode, names: ReadonlySet<string>): SyntaxNode | null => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (names.has(child.name)) return child;
    }
    return null;
};

const symbolKindOf = (node: SyntaxNode): DocumentSymbolKind | null => {
    if (HEADING_RE.test(node.name)) return 'heading';
    const declared = DECLARATION_KINDS.get(node.name);
    if (declared) return declared;
    const binding = BINDING_DECLARATIONS.get(node.name);
    return binding && childNamed(node, FUNCTION_VALUES) ? binding : null;
};

const headingText = (state: EditorState, node: SyntaxNode): string => {
    const firstLine = state.doc.lineAt(node.from);
    return firstLine.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim();
};

/**
 * Every nameable declaration in document order. Parses up to `timeoutMs` to
 * cover the whole file; a file too large to parse in time lists what was
 * reached.
 */
export const readDocumentSymbols = (state: EditorState, timeoutMs = 200): DocumentSymbol[] => {
    const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs);
    if (!tree) return [];
    const symbols: DocumentSymbol[] = [];
    const openEnds: number[] = [];
    tree.iterate({
        enter: (ref) => {
            const kind = symbolKindOf(ref.node);
            if (!kind) return;
            let name: string;
            let from: number;
            if (kind === 'heading') {
                name = headingText(state, ref.node);
                from = ref.from;
            } else {
                const nameNode = childNamed(ref.node, NAME_NODES);
                if (!nameNode) return;
                name = state.sliceDoc(nameNode.from, nameNode.to);
                from = nameNode.from;
            }
            if (!name) return;
            while (openEnds.length > 0 && openEnds[openEnds.length - 1] <= ref.from) openEnds.pop();
            const depth = kind === 'heading' ? Number(HEADING_RE.exec(ref.name)?.[1] ?? 1) - 1 : openEnds.length;
            symbols.push({ name, kind, line: state.doc.lineAt(from).number, from, depth });
            if (kind !== 'heading') openEnds.push(ref.to);
        },
    });
    return symbols;
};

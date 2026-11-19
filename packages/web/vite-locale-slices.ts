import { parseAst, type Plugin, type Rollup } from 'vite';


const LOCALE_DICTIONARY = /[\\/]i18n[\\/]messages[\\/]([A-Za-z]{2}(?:-[A-Za-z]{2})?)(?:\.settings)?\.ts$/;
const FEATURE_FILE = /[\\/]i18n[\\/]messages[\\/][^\\/]+\.i18n\.ts$/;
const QUERY = '?i18n-locale=';

type Program = Rollup.ProgramNode;
type Span = { start: number; end: number };

const exportedObject = (program: Program) => {
  const exported = program.body.filter((node) => node.type === 'ExportNamedDeclaration');
  if (exported.length !== 1 || exported[0].type !== 'ExportNamedDeclaration') return null;
  const declaration = exported[0].declaration;
  if (declaration?.type !== 'VariableDeclaration' || declaration.declarations.length !== 1) return null;
  const init = declaration.declarations[0].init;
  return init?.type === 'ObjectExpression' ? init : null;
};

type ObjectExpression = NonNullable<ReturnType<typeof exportedObject>>;
type Member = ObjectExpression['properties'][number];

// SAFETY: Rollup's parser sets `start` and `end` on every node; its types
// declare them on the program only.
const spanOf = (node: Member | ObjectExpression): Span => node as (Member | ObjectExpression) & Span;

const memberName = (member: Member): string | null => {
  if (member.type !== 'Property' || member.computed) return null;
  if (member.key.type === 'Identifier') return member.key.name;
  return member.key.type === 'Literal' ? String(member.key.value) : null;
};

export const dictionaryLocale = (importer: string): string | null => LOCALE_DICTIONARY.exec(importer)?.[1] ?? null;

export const localeSliceId = (featureId: string, locale: string): string | null => (
  FEATURE_FILE.test(featureId) ? `${featureId}${QUERY}${locale}` : null
);

export const sliceLocale = (code: string, id: string): string | null => {
  const queryAt = id.indexOf(QUERY);
  if (queryAt < 0) return null;
  const locale = id.slice(queryAt + QUERY.length);
  const object = exportedObject(parseAst(code));
  if (!object) return null;
  const kept: string[] = [];
  for (const member of object.properties) {
    const name = memberName(member);
    if (name === null) return null;
    if (name === locale) {
      const { start, end } = spanOf(member);
      kept.push(code.slice(start, end));
    }
  }
  const { start, end } = spanOf(object);
  return `${code.slice(0, start)}{${kept.join(',')}}${code.slice(end)}`;
};

export const localeSlicesPlugins = (): Plugin[] => [
  {
    name: 'openchamber-i18n-locale-slices:resolve',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.includes('.i18n')) return null;
      const locale = dictionaryLocale(importer);
      if (!locale) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const id = resolved ? localeSliceId(resolved.id, locale) : null;
      return resolved && id ? { ...resolved, id } : null;
    },
  },
  {
    name: 'openchamber-i18n-locale-slices:slice',
    enforce: 'post',
    transform(code, id) {
      const sliced = sliceLocale(code, id);
      return sliced === null ? null : { code: sliced, map: null };
    },
  },
];

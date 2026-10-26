import type { Theme } from '../../types/theme';

/** Every renderer shares these relationships. JSON contains only exceptions. */
export function resolveSyntaxTokens(syntax: Theme['colors']['syntax']) {
  const b = syntax.base;
  const t = syntax.tokens ?? {};
  const property = t.variableProperty ?? b.variable;
  const className = t.className ?? t.class ?? b.type;
  return {
    commentDoc: b.comment,
    stringEscape: b.foreground, stringInterpolation: b.variable, stringRegex: b.string,
    keywordControl: b.keyword, keywordOperator: b.operator, keywordImport: b.operator, keywordReturn: b.keyword,
    storageModifier: b.keyword,
    functionCall: b.function, functionBuiltin: b.function, method: b.function, methodCall: t.method ?? b.function,
    variableBuiltin: b.variable, variableProperty: property, variableReadonly: b.number,
    variableOther: b.variable, variableGlobal: b.string, variableLocal: b.variable,
    parameter: t.stringEscape ?? b.foreground,
    typePrimitive: b.type, typeInterface: t.interface ?? b.type, interface: b.type,
    class: className, className, struct: className, enum: className, typeParameter: b.type,
    boolean: b.keyword, null: b.number, constant: b.number,
    punctuation: b.comment, delimiter: t.punctuation ?? b.comment, bracket: b.foreground,
    tag: b.keyword, jsxTag: t.tag ?? b.keyword, tagAttribute: property, tagAttributeValue: b.string,
    tagBracket: t.punctuation ?? b.comment,
    decorator: b.function, annotation: b.function, namespace: b.type, module: b.operator,
    label: b.operator, macro: b.keyword, preprocessor: b.operator, regex: b.string, url: b.string,
    key: property, exception: b.operator,
    ...t,
  };
}

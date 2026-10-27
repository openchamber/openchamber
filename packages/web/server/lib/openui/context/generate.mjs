import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../../../..');
process.env.OPENUI_TELEMETRY_DISABLED = '1';
const requireFromUi = createRequire(path.join(root, 'packages/ui/package.json'));
await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
const staging = await fs.mkdtemp(path.join(root, 'tmp/openui-assets-'));

async function write(name, body) {
  await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
  await fs.writeFile(path.join(staging, name), `${body.trim()}\n`);
}

try {
  const producer = await import('../../../../../ui/src/components/chat/openui/openuiCatalog.schema.ts');
  const { OPENUI_RESIDENT_COMPONENT_NAMES } = await import('../../../../../ui/src/components/chat/openui/openuiSchema.ts');
  const catalog = producer.deriveOpenUICatalog();
  const { schema, spec, root: rootName } = catalog;
  const names = Object.keys(spec.components);
  if (rootName !== 'Stack' || names.length !== 48) {
    throw new Error('OpenUI catalog must contain the selected 48 components');
  }
  const residents = OPENUI_RESIDENT_COMPONENT_NAMES;
  const rules = /rules\?: (\{[^}]+\})/.exec(spec.components.Input.signature)?.[1];
  if (!rules) throw new Error('OpenUI Input must provide the shared Rules signature');
  const lines = (selected) => selected.map((name) => {
    const component = spec.components[name];
    if (!component) throw new Error(`OpenUI component ${name} is missing`);
    return component.signature.replaceAll(`rules?: ${rules}`, 'rules?: Rules');
  }).join('\n');
  const { generateSystemPrompt } = await import(pathToFileURL(requireFromUi.resolve('@openuidev/lang-core')).href);
  const { openuiExamples, openuiAdditionalRules, openuiChatAdditionalRules } = await import(
    pathToFileURL(requireFromUi.resolve('@openuidev/react-ui/genui-lib/prompt-options')).href
  );
  const { inspectOpenUIProgram } = await import('../../../../shared/openui/program.js');
  const selectRule = (rules, prefix) => {
    const matches = rules.filter((rule) => rule.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`Expected one official rule: ${prefix}`);
    return matches[0];
  };
  const example = (title) => {
    const source = selectRule(openuiExamples, title);
    const start = source.indexOf('\n\nroot =');
    if (start < 0) throw new Error(`Missing official example program: ${title}`);
    const program = source.slice(start + 2);
    const result = inspectOpenUIProgram(program, schema, catalog.componentSlots);
    if (!result.valid) throw new Error(`Official example is incompatible: ${title}\n${JSON.stringify(result.diagnostics)}`);
    return `### ${source.slice(0, start)}\n\n\`\`\`openui-lang literal\n${program}\n\`\`\``;
  };
  const officialPrompt = generateSystemPrompt({ library: spec, promptOptions: { toolCalls: false, bindings: true, builtinFunctions: true } });
  const section = (heading) => {
    const marker = `## ${heading}\n`;
    const start = officialPrompt.indexOf(marker);
    if (start < 0 || officialPrompt.indexOf(marker, start + marker.length) >= 0) {
      throw new Error(`Expected one official OpenUI section: ${heading}`);
    }
    const end = officialPrompt.indexOf('\n## ', start + marker.length);
    const body = officialPrompt.slice(start + marker.length, end < 0 ? undefined : end).trim();
    if (!body) throw new Error(`Empty official OpenUI section: ${heading}`);
    return body;
  };
  const syntax = section('Syntax Rules').split('\n');
  if (syntax.length !== 17 || syntax.slice(0, 16).some((line, index) => !line.startsWith(`${index + 1}. `))) {
    throw new Error('Official syntax rules changed; review the base/advanced selection');
  }
  // Rule 8 permits undeclared state, which the host rejects. Local instructions own it.
  const baseSyntax = [...syntax.slice(0, 7), syntax[16]].join('\n');
  const advancedSyntax = syntax.slice(8, 16).map((line, index) => line.replace(/^\d+\./, `${index + 1}.`)).join('\n');
  const functions = officialPrompt.split('\n').filter((line) => /^@[A-Za-z]+\(/.test(line));
  if (functions.length !== 14) throw new Error(`OpenUI must provide 14 data functions, received ${functions.length}`);
  const componentGroups = {
    data: ['Table', 'Col', 'BarChart', 'LineChart', 'AreaChart', 'Series', 'PieChart'],
    interaction: ['Form', 'FormControl', 'Input', 'TextArea', 'Select', 'SelectItem', 'DatePicker', 'Slider', 'CheckBoxGroup', 'CheckBoxItem', 'RadioGroup', 'RadioItem', 'SwitchGroup', 'SwitchItem', 'Chips', 'ChipItem', 'OptionCards', 'OptionCard', 'Button', 'Buttons', 'IconButton'],
    html: ['HtmlView'],
  };
  const assigned = [...residents, ...Object.values(componentGroups).flat()];
  if (new Set(assigned).size !== assigned.length || assigned.length !== names.length || names.some((name) => !assigned.includes(name))) {
    throw new Error('Every OpenUI component must have exactly one resident or group schema owner');
  }
  const files = {};
  files['gen.instruction.md'] = `## Syntax Rules\n\n${baseSyntax}\n\n## Hoisting & Streaming\n\n${section('Hoisting & Streaming (CRITICAL)')}`;
  files['gen.schema.md'] = `### Components\n${lines(residents)}`;
  // The function signature already states the Each scope rule; omit its repeated footer.
  const builtins = section('Built-in Functions').split('\n\nIMPORTANT @Each rule:');
  if (builtins.length !== 2) throw new Error('Official Each guidance changed; review deduplication');
  const reactive = selectRule(openuiAdditionalRules, '$variables are reactive:');
  if (!reactive.includes('all Queries and expressions')) throw new Error('Official reactive guidance changed');
  files['groups/advanced/gen.instruction.md'] = `## Expressions\n\n${advancedSyntax}\n\n${reactive.replace('all Queries and expressions', 'all expressions')}\n\n## Data functions\n\n${builtins[0]}`;
  const localActions = section('Action — Button Behavior').split('\n').filter((line) => /^- @(Set|Reset)\(/.test(line));
  if (localActions.length !== 2) throw new Error('Official local actions changed');
  files['groups/data/gen.instruction.md'] = [
    '# Data',
    selectRule(openuiChatAdditionalRules, 'For large chart values,'),
    '## Official examples\n\nDemonstration data.',
    example('Example 1 — Table (column-oriented):'),
    example('Example 2 — Bar chart:'),
  ].join('\n\n');
  files['groups/interaction/gen.instruction.md'] = [
    '# Interaction',
    ...['For forms, define one FormControl', 'For forms, always provide', 'Never nest Form'].map((prefix) => selectRule(openuiAdditionalRules, prefix)),
    '## Local state actions\n\n' + localActions.join('\n'),
    '## Official example\n\nDemonstration form.',
    example('Example 3 — Form with validation:'),
  ].join('\n\n');
  for (const [group, components] of Object.entries(componentGroups)) {
    const types = group === 'interaction' ? `### Types\nRules = ${rules}\n\n` : '';
    files[`groups/${group}/gen.schema.md`] = `${types}### Components\n${lines(components)}`;
  }
  files['generated/gen.schema.json'] = JSON.stringify({ ...spec, schema, root: rootName }, null, 2);

  for (const [name, content] of Object.entries(files)) await write(name, content);
  for (const name of Object.keys(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.rename(path.join(staging, name), path.join(directory, name));
  }
  console.log(`OpenUI contracts: ${names.length} components, ${residents.length} resident signatures, ${functions.length} functions`);
} finally {
  // This directory was created by this invocation; never clear the published
  // assets on a failed build or remove another process's staging directory.
  await fs.rm(staging, { recursive: true, force: true });
}

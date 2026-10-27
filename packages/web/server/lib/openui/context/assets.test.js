import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { readOpenUIGuidance, readOpenUIInstructionGroups } from './assets.js';
import { collectOpenUIFences } from '@openchamber/ui/components/chat/markdown/openuiFences';
import { inspectOpenUI } from '../program.js';

describe('OpenUI instruction assets', () => {
  it('reads fixed groups in request order without duplicates', async () => {
    const result = await readOpenUIInstructionGroups(['html', 'examples', 'html']);
    expect(result.groups).toEqual(['html', 'examples']);
    expect(result.content).toContain('# HtmlView');
    const { content: index } = await readOpenUIInstructionGroups();
    const guidance = await readOpenUIGuidance();
    expect(guidance.startsWith(`${index}\n\n`)).toBe(true);
    expect(guidance).toMatch(/OpenUI catalog revision: [a-f0-9]{64}\.$/);
    expect(collectOpenUIFences(guidance)).toHaveLength(0);
  });

  it('rejects an unknown group rather than reading a caller path', async () => {
    await expect(readOpenUIInstructionGroups(['../../etc/passwd'])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reads every declared group in one request and rejects oversized requests', async () => {
    const groups = ['data', 'interaction', 'html', 'advanced', 'examples'];
    const result = await readOpenUIInstructionGroups(groups);
    expect(result.groups).toEqual(groups);
    await expect(readOpenUIInstructionGroups([...groups, 'data'])).rejects.toMatchObject({ statusCode: 400 });
    await expect(readOpenUIInstructionGroups(['base'])).rejects.toMatchObject({ statusCode: 400 });
    await expect(readOpenUIInstructionGroups(['media'])).rejects.toMatchObject({ statusCode: 400 });
    await expect(readOpenUIInstructionGroups(['diagrams'])).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each([
    [['examples'], 2], [['data'], 2], [['interaction'], 1], [['advanced'], 0],
  ])('discloses complete examples for %j that pass the shipped parser, evaluator and host rules', async (groups, count) => {
    const { groups: loadedGroups, content } = await readOpenUIInstructionGroups(groups);
    expect(loadedGroups).toEqual(groups);
    const programs = collectOpenUIFences(content);
    expect(programs).toHaveLength(count);
    for (const program of programs) {
      expect(program.closed).toBe(true);
      expect(program.literal).toBe(true);
      expect(inspectOpenUI(program.code)).toMatchObject({ valid: true });
    }
  });

  it('delivers selected official examples without handwritten rewrites', async () => {
    const requireFromUi = createRequire(new URL('../../../../../ui/package.json', import.meta.url));
    const { openuiExamples } = await import(pathToFileURL(requireFromUi.resolve('@openuidev/react-ui/genui-lib/prompt-options')).href);
    for (const [group, indices] of [['data', [0, 1]], ['interaction', [2]]]) {
      const { content } = await readOpenUIInstructionGroups([group]);
      const programs = collectOpenUIFences(content).map(({ code }) => code.trim());
      expect(programs).toEqual(indices.map((index) => openuiExamples[index].slice(openuiExamples[index].indexOf('root =')).trim()));
    }
  });

  it('discloses every catalog signature exactly once across resident and optional references', async () => {
    const signatures = (content) => [...content.matchAll(/^([A-Z]\w*)\(\w+\??: /gm)].map((match) => match[1]);
    const resident = await readOpenUIGuidance();
    expect(signatures(resident).sort()).toEqual([
      'Stack', 'Card', 'CardHeader', 'TextContent', 'Callout', 'Grid', 'GridItem', 'Separator', 'TagBlock', 'Tag', 'Icon',
      'Image', 'ImageGallery', 'Label', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem', 'Carousel',
    ].sort());
    const { content: data } = await readOpenUIInstructionGroups(['data']);
    expect(signatures(data).sort()).toEqual(['Table', 'Col', 'BarChart', 'LineChart', 'AreaChart', 'Series', 'PieChart'].sort());
    const { content: interaction } = await readOpenUIInstructionGroups(['interaction']);
    expect(signatures(interaction)).toHaveLength(21);
    expect(signatures(interaction)).toEqual(expect.arrayContaining(['Form', 'Input', 'Button']));
    const optional = await readOpenUIInstructionGroups(['data', 'interaction', 'html', 'advanced', 'examples']);
    const catalog = JSON.parse(await readFile(new URL('./generated/gen.schema.json', import.meta.url), 'utf8'));
    const delivered = [...signatures(resident), ...signatures(optional.content)];
    expect(delivered.sort()).toEqual(Object.keys(catalog.components).sort());
    expect(new Set(delivered).size).toBe(delivered.length);
    expect((resident + optional.content).match(/^Rules = /gm)).toHaveLength(1);
    expect(inspectOpenUI('root = Stack([Icon("arrow-right")])')).toMatchObject({ valid: true });
    const { content: advanced } = await readOpenUIInstructionGroups(['advanced']);
    const functions = advanced.split('## Data functions\n')[1];
    expect(functions.split('\n').filter((line) => /^@[A-Za-z]+\(/.test(line))).toHaveLength(14);
    expect(interaction).toContain('Rules = {required?: boolean');
  });
});

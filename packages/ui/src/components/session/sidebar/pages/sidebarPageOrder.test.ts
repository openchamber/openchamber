import { describe, expect, test } from 'bun:test';
import { nextSidebarPageOrder, orderSidebarPages } from './sidebarPageOrder';

const pages = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((page) => page.id);

describe('orderSidebarPages', () => {
  test('lists the pages in the stored order', () => {
    expect(ids(orderSidebarPages(pages('overview', 'archive', 'stats', 'guest:voice'), ['guest:voice', 'stats', 'overview', 'archive'])))
      .toEqual(['guest:voice', 'stats', 'overview', 'archive']);
  });

  test('a page the stored order does not name appears after the page it follows by default', () => {
    // A newly installed extension and a built-in page an older build did not have.
    const available = pages('overview', 'source-board', 'archive', 'guest:voice', 'guest:graph');
    expect(ids(orderSidebarPages(available, ['archive', 'guest:voice', 'overview'])))
      .toEqual(['archive', 'guest:voice', 'guest:graph', 'overview', 'source-board']);
    expect(ids(orderSidebarPages(pages('new-first', 'archive'), ['archive']))).toEqual(['new-first', 'archive']);
  });

  test('a stored page this surface lacks takes no place', () => {
    expect(ids(orderSidebarPages(pages('archive', 'stats'), ['guest:gone', 'stats', 'overview', 'archive']))).toEqual(['stats', 'archive']);
  });
});

describe('nextSidebarPageOrder', () => {
  test('keeps pages this surface lacks after the page they followed', () => {
    expect(nextSidebarPageOrder(['stats', 'archive'], ['overview', 'archive', 'guest:elsewhere', 'stats']))
      .toEqual(['overview', 'stats', 'archive', 'guest:elsewhere']);
  });

  test('stores the arrangement as it is when nothing was stored', () => {
    expect(nextSidebarPageOrder(['stats', 'archive'], [])).toEqual(['stats', 'archive']);
  });
});

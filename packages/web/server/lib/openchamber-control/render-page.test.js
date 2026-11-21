import { describe, expect, it } from 'vitest';

import { renderPageImageSources } from './render-page.js';

describe('renderPageImageSources', () => {
  it('reads a quoted path that holds a quote other than the one around it, as a folder name can', () => {
    expect(renderPageImageSources(`<img src="C:/preview/chef's/icon.png">`)).toEqual(["C:/preview/chef's/icon.png"]);
    expect(renderPageImageSources(`<script>const shot = 'C:/preview/chef"s/icon.png';</script>`)).toEqual(['C:/preview/chef"s/icon.png']);
  });

  it('needs the closing quote of the string it opened, so prose before a path is not one', () => {
    expect(renderPageImageSources("<p>Don't look at /tmp/a.png here</p>")).toEqual([]);
    expect(renderPageImageSources('<img src="/tmp/unclosed.png')).toEqual([]);
  });

  it('still reads the unquoted url() form', () => {
    expect(renderPageImageSources('<div style="background:url(/tmp/chef.png)"></div>')).toEqual(['/tmp/chef.png']);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'parse5';

const root = new URL('../../../', import.meta.url);

test('app DOM declarations match the search shell and cached selectors', async () => {
  const [html, source, types] = await Promise.all([
    readFile(new URL('static/index.html', root), 'utf8'),
    readFile(new URL('static/app.js', root), 'utf8'),
    readFile(new URL('typings/search-app.d.ts', root), 'utf8'),
  ]);
  const nodes = new Map();
  function visit(node) {
    const id = node.attrs?.find(attr => attr.name === 'id')?.value;
    if (id) {
      assert.ok(!nodes.has(id), `duplicate id ${id}`);
      nodes.set(id, node.tagName);
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(parse(html));
  const declarations = types.slice(types.indexOf('interface PagesSearchDOM'));
  const typed = new Map([...declarations.matchAll(/\b(\w+): (HTML\w*Element|SVGSVGElement)( \| null)?/g)]
    .map(match => [match[1], {type: match[2], optional: !!match[3]}]));
  const selectors = [...source.matchAll(/DOM\.(\w+) = \$\("#([^"]+)"\)/g)];
  assert.equal(selectors.length, typed.size);
  const tags = { HTMLInputElement: 'input', HTMLButtonElement: 'button', HTMLSelectElement: 'select',
    HTMLAnchorElement: 'a', SVGSVGElement: 'svg' };
  for (const [, name, id] of selectors) {
    const declaration = typed.get(name);
    assert.ok(declaration, `missing declaration for ${name}`);
    const tag = nodes.get(id);
    if (!tag && declaration.optional) continue;
    assert.ok(tag, `missing required #${id}`);
    if (tags[declaration.type]) assert.equal(tag, tags[declaration.type], `#${id}`);
    else assert.notEqual(tag, 'svg', `#${id} is not an HTMLElement`);
  }
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { createDocument, schema } from '@/lib/prosemirror';

const LATEX = String.raw`I=\frac{U}{R}`;

function serialize(doc: ProseMirrorNode): string {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return host.innerHTML;
}

function formulaNode(doc: ProseMirrorNode): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  doc.descendants((node) => {
    if (node.type.name === 'inline_math') found = node;
  });
  return found;
}

describe('legacy canvas inline math', () => {
  it('keeps a formula atom when adjacent text is edited', () => {
    const html = `<p style="font-size:20px">Ohm's law: <span data-inline-math="${LATEX}">${LATEX}</span>, and more</p>`;
    const doc = createDocument(html);
    const formula = formulaNode(doc);
    expect(formula?.attrs.latex).toBe(LATEX);

    const edited = EditorState.create({ doc }).tr.insertText('x', 1).doc;
    expect(edited.textContent.startsWith('x')).toBe(true);
    expect(formulaNode(edited)?.attrs.latex).toBe(LATEX);

    const saved = serialize(edited);
    expect(saved).toContain(`data-inline-math="${LATEX}"`);
    expect(formulaNode(createDocument(saved))?.attrs.latex).toBe(LATEX);
  });

  it('reads a KaTeX annotation as one formula instead of its glyphs', () => {
    const latex = String.raw`\frac{i^{\left(m\right)}}{m}`;
    const html = `<p>用${katex.renderToString(latex)}表示</p>`;
    const doc = createDocument(html);
    expect(formulaNode(doc)?.attrs.latex).toBe(latex);
    expect(doc.textContent).toBe(`用${latex}表示`);
    expect(serialize(doc)).toContain('data-inline-math');
    expect(formulaNode(createDocument(serialize(doc)))?.attrs.latex).toBe(latex);
  });
});

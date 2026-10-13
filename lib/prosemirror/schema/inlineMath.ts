import katex from 'katex';
import { safeKatexOptions } from '@openmaic/dsl';
import { MAX_INLINE_MATH_SOURCE } from '@openmaic/renderer';
import type { NodeSpec } from 'prosemirror-model';

/**
 * Atom for `span[data-inline-math]` and KaTeX output. The legacy canvas schema
 * otherwise parses a formula as ordinary text, so editing the surrounding
 * sentence drops the marker and the next save stores raw LaTeX.
 */
export const inlineMath: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  leafText: (node) => (typeof node.attrs.latex === 'string' ? node.attrs.latex : ''),
  attrs: { latex: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-inline-math]',
      priority: 100,
      getAttrs: (dom) => {
        const latex = (dom as HTMLElement).getAttribute('data-inline-math');
        return latex !== null ? { latex } : false;
      },
    },
    {
      tag: 'span.katex',
      priority: 100,
      getAttrs: (dom) => {
        const latex = (dom as HTMLElement).querySelector(
          'annotation[encoding="application/x-tex"]',
        )?.textContent;
        return latex ? { latex } : false;
      },
    },
  ],
  toDOM: (node) => {
    const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
    const host = document.createElement('span');
    // Empty or malformed source must not prevent the surrounding text from
    // saving. Keep the atom and its source even when KaTeX cannot typeset it.
    let formula = host;
    if (latex.length > MAX_INLINE_MATH_SOURCE) {
      host.textContent = latex;
    } else if (latex.trim()) {
      try {
        katex.render(
          latex,
          host,
          safeKatexOptions({
            displayMode: false,
            throwOnError: false,
          }),
        );
        formula = (host.firstElementChild as HTMLElement | null) ?? host;
      } catch {
        host.textContent = latex;
      }
    }
    formula.setAttribute('data-inline-math', latex);
    formula.setAttribute('contenteditable', 'false');
    return formula;
  },
};

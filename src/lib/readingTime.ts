import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

export interface ReadingInfo {
  readingTime: string;
  hasProse: boolean;
}

// Medium's read-time rule: 265 words/min for text, +12s per image.
// `hasProse` flags whether the piece has actual running prose (paragraph /
// list text, not just link labels or headings) so image- or link-only pages
// can skip showing a read time.
//
// Computed from the raw markdown body in the page component rather than via a
// remark plugin. A remark plugin writes into Astro's cached markdown render,
// which is keyed on the content file's digest — so a plugin change alone won't
// re-run against unchanged `.md` files on a warm build cache (e.g. Vercel),
// silently dropping newly-added fields. `entry.body` only changes when the
// source changes, so recomputing here every build stays correct.
export function readingInfo(markdown: string): ReadingInfo {
  const tree = unified().use(remarkParse).parse(markdown ?? '');
  let words = 0;
  let images = 0;
  let proseWords = 0;
  visit(tree, (node, _index, parent) => {
    if (node.type === 'image') {
      images++;
    } else if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      const matches = (node.value ?? '').match(/\S+/g);
      const count = matches ? matches.length : 0;
      words += count;
      if (node.type === 'text' && parent?.type !== 'link' && parent?.type !== 'heading') {
        proseWords += count;
      }
    }
  });
  const seconds = (words / 265) * 60 + images * 12;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { readingTime: `${minutes} min read`, hasProse: proseWords > 0 };
}

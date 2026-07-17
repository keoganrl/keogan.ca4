import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import { visit } from 'unist-util-visit';

// Medium's read-time rule: 265 words/min for text, +12s per image.
// Also flags whether the piece has actual prose (running paragraph/list
// text) vs. being only images and links, so pages like a photo dump or a
// links list can skip showing a read time.
function remarkReadingTime() {
  return (tree, file) => {
    let words = 0;
    let images = 0;
    let proseWords = 0;
    visit(tree, (node, index, parent) => {
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
    file.data.astro.frontmatter.readingTime = `${minutes} min read`;
    file.data.astro.frontmatter.hasProse = proseWords > 0;
  };
}

export default defineConfig({
  output: 'static',
  adapter: vercel({
    webAnalytics: {
      enabled: true,
    },
  }),
  site: 'https://keogan.ca',
  integrations: [
    svelte(),
    sitemap({
      filter: (page) =>
        !page.startsWith('https://keogan.ca/her') &&
        !page.startsWith('https://keogan.ca/chips'),
    }),
  ],
  markdown: {
    remarkPlugins: [remarkReadingTime],
  },
  build: {
    inlineStylesheets: 'always',
  },
});

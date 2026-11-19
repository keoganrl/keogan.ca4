import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';

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
  build: {
    inlineStylesheets: 'always',
  },
  // Markdown images (and any <Image> without its own widths) get a srcset and
  // sizes, so a phone downloads a phone-sized drawing. Styling stays ours:
  // responsiveStyles is off, and .article-body img already sets width: 100%.
  image: {
    layout: 'constrained',
  },
});

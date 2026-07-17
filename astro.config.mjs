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
});

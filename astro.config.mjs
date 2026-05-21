import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  adapter: vercel({
    webAnalytics: {
      enabled: true,
    },
  }),
  site: 'https://keogan.ca',
  integrations: [
    sitemap({
      filter: (page) => !page.startsWith('https://keogan.ca/her'),
    }),
  ],
  build: {
    inlineStylesheets: 'always',
  },
});

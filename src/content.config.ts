import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    year: z.number(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string().optional(),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    year: z.number(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string().optional(),
    link: z.string().url().optional(),
  }),
});

export const collections = { writing, projects };

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
    // When set, the projects-list row links straight here instead of to the
    // generated /projects/<slug> detail page (may be an on-site path like /chips).
    href: z.string().optional(),
    // A collaborator credited beside the title, as a separate link.
    collaborator: z.object({ name: z.string(), url: z.string().url() }).optional(),
  }),
});

export const collections = { writing, projects };

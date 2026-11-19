import { defineCollection, z, type SchemaContext } from 'astro:content';
import { glob } from 'astro/loaders';

// Optional full-bleed cover photo with the title over it (src/components/Cover.astro).
// position / mobilePosition are CSS object-position values for the crop.
// `src` is a path relative to the .md file (src/assets/images/...), so Astro
// can resize and re-encode it; a /public path would ship the original as-is.
const coverSchema = (image: SchemaContext['image']) => z.object({
  src: image(),
  alt: z.string(),
  position: z.string().optional(),
  mobilePosition: z.string().optional(),
}).optional();

const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    year: z.number(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string().optional(),
    cover: coverSchema(image),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: ({ image }) => z.object({
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
    cover: coverSchema(image),
  }),
});

export const collections = { writing, projects };

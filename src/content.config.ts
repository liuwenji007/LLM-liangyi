import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const source = z.object({
  url: z.string().url(),
  archive: z.string().url().optional(),
});

const meme = z.object({
  file: z.string().min(1),
  title: z.string().optional(),
  author: z.string().min(1),
  license: z.string().default("CC BY-NC 4.0"),
});

const events = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/data/events" }),
  schema: z
    .object({
      date: z.coerce.date(),
      side: z.enum(["light", "dark"]),
      vendor: z.string().min(1),
      model: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().min(1),
      basis: z.enum(["official", "independent"]).optional(),
      category: z.array(z.string()).default([]),
      severity: z.number().int().min(1).max(5).optional(),
      related: z.string().optional(),
      sources: z.array(source).min(1),
      response: z.string().optional(),
      verified: z.boolean().default(false),
      memes: z.array(meme).default([]),
    })
    .superRefine((data, ctx) => {
      if (data.side === "dark" && data.severity === undefined) {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "暗史必须填严重程度" });
      }
      if (data.side === "light" && data.severity !== undefined) {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "明史不填严重程度" });
      }
      if (data.side === "light" && data.related !== undefined) {
        ctx.addIssue({ code: "custom", path: ["related"], message: "只有暗史填 related" });
      }
      if (data.category.includes("误用") && (data.severity ?? 0) > 3) {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "误用类最多 3 级" });
      }
      if (data.category.includes("自披露") && (data.severity ?? 0) > 2) {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "自披露类最多 2 级" });
      }
    }),
});

export const collections = { events };

import { extractOpenGraph, IOGResult } from "@devmehq/open-graph-extractor";
import QuickLRU from "quick-lru";
import { actor, setup, UserError } from "rivetkit";

export const embeds = actor({
  vars: {
    lru: new QuickLRU<string, IOGResult>({ maxSize: 1000 }),
  },
  actions: {
    async getEmbed(c, url: string) {
      const cached = c.vars.lru.get(url);
      if (cached) return cached;

      let client = c.client<typeof registry>();
      try {
        const embed = await client.embedFetcher
          .getOrCreate("main")
          .fetchEmbed(url);

        c.vars.lru.set(url, embed);

        return embed;
      } catch (e) {
        throw new UserError("testing");
      }
    },
  },
});

export const embedFetcher = actor({
  actions: {
    async fetchEmbed(c, url: string) {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new UserError("Error fetching URL");
      }
      const html = await resp.text();
      const ogData = extractOpenGraph(html);
      return ogData;
    },
  },
});

export const registry = setup({
  use: { embeds, embedFetcher },
});

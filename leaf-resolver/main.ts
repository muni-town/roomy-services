import { AutoRouter, cors, error } from "itty-router";
import { EntityId, EntityIdStr } from "@muni-town/leaf";

async function resolveTxt(hostname: string) {
  try {
    return (await Deno.resolveDns(hostname, "TXT")).flat();
  } catch (_) {
    return [];
  }
}

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

router.get(
  "/xrpc/town.muni.01JQ1SV7YGYKTZ9JFG5ZZEFDNK.resolve-leaf-id",
  async ({ query }) => {
    const { domain } = query;
    if (typeof domain !== "string" || !domain)
      return error(400, "domain query parameter required");

    const records = await resolveTxt(`_leaf.${domain}`);
    let id: EntityIdStr | undefined;
    for (const record of records) {
      const [key, value] = record.split("=");
      if (key == "id") {
        try {
          id = new EntityId(value as EntityIdStr).toString();
          break;
        } catch (_e) {
          // Just ignore invalid IDs.
        }
      }
    }

    return { id };
  }
);

Deno.serve(router.fetch);

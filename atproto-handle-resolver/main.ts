import { AutoRouter, cors, error } from "itty-router";
import { AtprotoHandleResolver } from "@atproto-labs/handle-resolver";

const atprotoResolver = new AtprotoHandleResolver({
  async resolveTxt(hostname) {
    try {
      return (await Deno.resolveDns(hostname, "TXT")).flat();
    } catch (_) {
      return [];
    }
  },
  fetch,
});

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

router.get("/xrpc/com.atproto.identity.resolveHandle", async ({ query }) => {
  const { handle } = query;
  if (typeof handle !== "string" || !handle)
    return error(400, "handle query parameter required");
  const did: string | null = await atprotoResolver.resolve(handle);
  if (!did) return error(404, `Could not resolve handle to DID: ${handle}`);
  return { did };
});

router.get("/xrpc/town.muni.leaf.resolveHandle", async ({ query }) => {
  const { handle } = query;
  if (typeof handle !== "string" || !handle)
    return error(400, "handle query parameter required");

  const txtRecords = (await Deno.resolveDns(`_leaf.${handle}`, "TXT"))
    .flat()
    .flatMap((x) => {
      const split = x.split("=");
      if (split.length == 2) {
        const [key, value] = split;
        return [{ key, value }];
      }
      return [];
    });
  const did: string | undefined = txtRecords.find((x) => x.key == "did")?.value;
  if (!did || !did.startsWith("did:"))
    return error(404, `Could not resolve handle to DID: ${handle}`);
  return { did };
});

Deno.serve(router.fetch);

import { AutoRouter, cors, error } from "itty-router";
import { AtprotoHandleResolver } from "@atproto-labs/handle-resolver";

const resolver = new AtprotoHandleResolver({
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
  const did: string | null = await resolver.resolve(handle);
  if (!did) return error(404, `Could not resolve handle to DID: ${handle}`);
  return { did };
});

Deno.serve(router.fetch);

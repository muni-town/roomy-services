import { AutoRouter, cors, error, IRequest, withContent } from "itty-router";
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver } from "@atproto/identity";
import {
  partialChange,
  SyncerStorage,
  HeadSyncer,
  PartialChange,
} from "./head-syncer.ts";
import z from "zod";

// TODO: add a DID cache using Deno KV
const idResolver = new IdResolver();
async function getSigningKey(
  did: string,
  forceRefresh: boolean
): Promise<string> {
  const atprotoData = await idResolver.did.resolveAtprotoData(
    did,
    forceRefresh
  );
  return atprotoData.signingKey;
}

const db = await Deno.openKv();
const getSyncerStorage = (docId: string): SyncerStorage => ({
  async load() {
    const data = await db.get(["roomy-spaces", "head-syncers", docId]);
    if (!data) return;
    return data.value as Uint8Array;
  },
  async save(data) {
    await db.set(["roomy-spaces", "head-syncers", docId], data, {
      // Keep cache of heads for 15 days. That means that brand-new users who join the space will
      // need to join within 15 days of somebody who's already joined the space in order to see
      // up-to-date info.
      //
      // This is a safety mechanism right now so our storage doesn't grow forever.
      expireIn: 1000 * 60 * 60 * 24 * 15,
    });
  },
});

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

const serviceDid = Deno.env.get("DID");

if (!serviceDid)
  throw new Error(
    "Must set DID environment variable to the DID of this deployed service."
  );

// Return the service DID
router.get("/.well-known/did.json", ({ url }) => ({
  "@context": ["https://www.w3.org/ns/did/v1"],
  id: serviceDid,
  service: [
    {
      id: "#roomy_spaces",
      type: "RoomySpacesServer",
      serviceEndpoint: (() => {
        const u = new URL(url);
        u.pathname = "/";
        return u.href;
      })(),
    },
  ],
}));

type JwtPayload = Awaited<ReturnType<typeof verifyJwt>>;
type AuthCtx = {
  jwtPayload: JwtPayload;
  did: string;
};

type Ctx = IRequest & AuthCtx;

// TODO: make this endpoint authenticated to prevent spam?
// Get the latest heads of the given document
router.get("/xrpc/chat.roomy.v0.space.sync.peers", async ({ query }) => {
  // Get the document ID from the request
  const { docId } = query;
  if (typeof docId != "string" || docId?.length == 0)
    return error(400, "string `docId` query param required.");

  // Load the head syncer
  const syncer = await HeadSyncer.init(getSyncerStorage(docId));

  return {
    // Return the calculated best peers to sync with to get the latest updates.
    peers: syncer.calculatePeersToDownloadFrom(),
  };
});

//
// AUTH WALL
//
// ALL REQUESTS PAST THIS POINT REQUIRE AUTH
//

router.all("*", async (ctx) => {
  const url = new URL(ctx.url);
  if (!url.pathname.startsWith("/xrpc/")) return error(404);
  const lxm = url.pathname.split("/xrpc/")[1];

  const authorization = ctx.headers.get("authorization");
  if (!authorization) return error(403, "Authorization token required.");
  if (!authorization.startsWith("Bearer "))
    return error(403, "Bearer token required");
  const jwt = authorization.split("Bearer ")[1];
  let jwtPayload: JwtPayload;
  try {
    jwtPayload = await verifyJwt(jwt, serviceDid, lxm, getSigningKey);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Error validating JWT:", e);
    return error(403, "Could not validate authorization JWT.");
  }

  ctx.jwtPayload = jwtPayload;
  ctx.did = jwtPayload.iss;

  return undefined;
});

// Get the user's personal keypair
router.post(
  "/xrpc/chat.roomy.v0.space.update",
  withContent,
  async ({ did, json }: Ctx) => {
    // Parse partial changes from request
    let docs: Record<string, PartialChange[]> = {};
    try {
      const jsonBody = await json();
      docs = z.record(z.array(partialChange)).parse(jsonBody);
    } catch (_) {
      return error(
        400,
        `Invalid body format, expected JSON, list of partial changes.`
      );
    }

    for (const [docId, changes] of Object.entries(docs)) {
      // Load the head syncer
      const syncer = await HeadSyncer.init(getSyncerStorage(docId));
      // Ingest the changes from the peer
      await syncer.ingestChanges(did, changes);
    }

    return {};
  }
);

Deno.serve(router.fetch);

import { AutoRouter, cors, error } from "itty-router";
import { IdResolver } from "@atproto/identity";
import { verifyJwt } from "@atproto/xrpc-server";
import encodeBase32 from "base32-encode";
import { SuperPeer1, StorageManager, SuperPeer1BinaryWrapper } from "@muni-town/leaf";
import { denoKvBlobStorageAdapter } from "@muni-town/leaf-storage-deno-kv";

// Parse configuration environment variables.
const dataDir = Deno.env.get("DATA_DIR");
const serviceDid = Deno.env.get("DID");
const serviceEndpoint = Deno.env.get("PUBLIC_URL");
const unsafeDevToken = Deno.env.get("UNSAFE_DEV_TOKEN");

const kv = await Deno.openKv(dataDir);
const superPeer = new SuperPeer1(new StorageManager(denoKvBlobStorageAdapter(kv)));

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

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

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
      id: "#roomy_syncserver",
      type: "RoomySyncserver",
      serviceEndpoint: (() => {
        if (serviceEndpoint) return serviceEndpoint;
        const u = new URL(url);
        u.pathname = "/";
        return u.href;
      })(),
    },
  ],
}));

// Open a websocket connection to the routing service.
router.get("/sync/as/:did", async (req) => {
  const { headers, params } = req;

  // Get that the user is trying to connect as from the URL.
  const did = params.did!;

  // Make sure this is a websocket request
  if (headers.get("upgrade") != "websocket") {
    return error(400, "Must set `upgrade` header to `websocket`.");
  }

  // Get the authorization token from the header
  const token = headers
    .get("Sec-WebSocket-Protocol")
    ?.split("authorization,")[1]
    ?.trim();
  if (!token) return error(403, "Missing authorization bearer token");

  // Load the token and make sure the DID matches to make sure it's valid.
  const tokenDid = (await kv.get<string>(["tokens", token])).value;

  if (did !== tokenDid && !(unsafeDevToken && token === unsafeDevToken))
    return error(403, "Token invalid or expired");

  // Upgrade to websocket connection
  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: "authorization",
  });
  socket.binaryType = "arraybuffer";

  const backend = new SuperPeer1BinaryWrapper(superPeer);

  socket.addEventListener("open", () => {
    backend.setReceiver((data) => {
      socket.send(data);
    });
    socket.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        backend.send(new Uint8Array(ev.data));
      }
    });
    socket.addEventListener("close", () => {
      backend.cleanup();
    });
  });

  return response;
});

//
// AUTH WALL
//
// ALL REQUESTS PAST THIS POINT REQUIRE AUTH
//

type JwtPayload = Awaited<ReturnType<typeof verifyJwt>>;
type AuthCtx = {
  jwtPayload: JwtPayload;
  did: string;
};
type Ctx = Request & AuthCtx;

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

// Get an access token that can be used to open up a WebSocket connection to the router.
router.get("/xrpc/chat.roomy.v0.sync.token", async ({ did }: Ctx) => {
  // Generate a new token
  const token = encodeBase32(
    crypto.getRandomValues(new Uint8Array(32)),
    "Crockford"
  );
  // Add the token to the key-value store and give it a lifetime of 30 seconds. Login attempts after
  // that time will fail.
  await kv.set(["tokens", token], did, {
    expireIn: 30000,
  });

  return {
    token,
  };
});

Deno.serve(router.fetch);

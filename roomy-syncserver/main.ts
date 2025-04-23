import { IdResolver } from "@atproto/identity";
import { verifyJwt } from "@atproto/xrpc-server";
import encodeBase32 from "base32-encode";
import { SuperPeer1, StorageManager } from "@muni-town/leaf";
import { denoKvBlobStorageAdapter } from "@muni-town/leaf-storage-deno-kv";
import { attachServer, io } from "@muni-town/leaf-sync-socket-io-server";
import { createServer } from "node:http";
import express from "express";

// Parse configuration environment variables.
const dataDir = Deno.env.get("DATA_DIR");
const serviceDid = Deno.env.get("DID");
const serviceEndpoint = Deno.env.get("PUBLIC_URL");
if (!serviceEndpoint) {
  console.error("PUBLIC_URL environment variable is required.");
  Deno.exit(1);
}
const unsafeDevToken = Deno.env.get("UNSAFE_DEV_TOKEN");
const port = parseInt(Deno.env.get("PORT") || "8000");

// Setup the key-value store, super peer, and socket.io server.
const kv = await Deno.openKv(dataDir);
const superPeer = new SuperPeer1(
  new StorageManager(denoKvBlobStorageAdapter(kv))
);
const socketIoServer = new io.Server({
  cors: {
    methods: "*",
    origin: "*",
  },
});
/** Authenticate incoming socket.io connections. */
socketIoServer.use(async (socket, next) => {
  const { did, token } = socket.handshake.auth;

  if (typeof did !== "string" || typeof token !== "string")
    return next(new Error("`did` and `token` required in Socket.io auth"));

  // Load the token and make sure the DID matches to make sure it's valid.
  const tokenDid = (await kv.get<string>(["tokens", token])).value;

  if (did !== tokenDid && !(unsafeDevToken && token === unsafeDevToken))
    return new Error("Token invalid or expired");

  next();
});

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

const app = express();

if (!serviceDid)
  throw new Error(
    "Must set DID environment variable to the DID of this deployed service."
  );

// Return the service DID
app.get("/.well-known/did.json", (_req, res) => {
  res.send({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: serviceDid,
    service: [
      {
        id: "#roomy_syncserver",
        type: "RoomySyncserver",
        serviceEndpoint,
      },
    ],
  });
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
// type Req =

app.use(async (req, res, next) => {
  if (!req.url.startsWith("/xrpc/")) {
    res.status(404).send("Page not found");
    return;
  }
  const lxm = req.url.split("/xrpc/")[1];

  const authorization = req.headers.authorization;
  if (!authorization) {
    res.status(403).send("Authorization token required.");
    return;
  }
  if (!authorization.startsWith("Bearer ")) {
    res.status(403).send("Bearer token required");
    return;
  }

  const jwt = authorization.split("Bearer ")[1];
  let jwtPayload: JwtPayload;
  try {
    jwtPayload = await verifyJwt(jwt, serviceDid, lxm, getSigningKey);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Error validating JWT:", e);
    res.status(403).send("Could not validate authorization JWT.");
    return;
  }

  (req as unknown as AuthCtx).jwtPayload = jwtPayload;
  (req as unknown as AuthCtx).did = jwtPayload.iss;

  next();
});

// Get an access token that can be used to open up a WebSocket connection to the router.
app.get("/xrpc/chat.roomy.v0.sync.token", async (req, res) => {
  // Generate a new token
  const token = encodeBase32(
    crypto.getRandomValues(new Uint8Array(32)),
    "Crockford"
  );
  // Add the token to the key-value store and give it a lifetime of 30 seconds. Login attempts after
  // that time will fail.
  await kv.set(["tokens", token], (req as unknown as AuthCtx).did, {
    expireIn: 30000,
  });

  res.send({
    token,
  });
});

// Add the router as middleware to the socket.io server
const httpServer = createServer(app);
attachServer(superPeer, socketIoServer, httpServer);
httpServer.listen(port);
console.log(`Listening on port ${port}`);

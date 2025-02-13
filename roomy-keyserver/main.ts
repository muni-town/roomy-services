import { AutoRouter, cors, error } from "itty-router";
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver } from "@atproto/identity";
import { isDid, extractDidMethod } from "@atproto/did";
import * as ed25519 from "@noble/ed25519";
import encodeBase32 from "base32-encode";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };
const encodeKey = (key: Uint8Array) =>
  encodeBase32(key, "Crockford").toLowerCase();

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
async function generateKeypair(): Promise<Keypair> {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  return {
    publicKey,
    privateKey,
  };
}
async function getKeypair(did: string): Promise<Keypair> {
  const entry = await db.get<Keypair>(["keys", did]);
  if (entry.value) {
    return entry.value;
  }
  const newKeypair = await generateKeypair();
  await db.set(["keys", did], newKeypair);
  return newKeypair;
}
async function getPublicKey(did: string): Promise<string> {
  const keypair = await getKeypair(did);
  return encodeKey(keypair.publicKey);
}
async function getEncodedKeypair(
  did: string
): Promise<{ publicKey: string; privateKey: string }> {
  const keypair = await getKeypair(did);
  return {
    publicKey: encodeKey(keypair.publicKey),
    privateKey: encodeKey(keypair.privateKey),
  };
}

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
      id: "#roomy_keyserver",
      type: "RoomyKeyserver",
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

type Ctx = Request & AuthCtx;

// Get a user's public key
router.get("/xrpc/chat.roomy.v0.key.public", async ({ query }) => {
  let { did } = query;
  if (typeof did !== "string" || !did)
    return error(400, "DID query parameter required");
  did = decodeURIComponent(did);
  if (!isDid(did)) return error(400, "Invalid DID");
  const didMethod = extractDidMethod(did);
  if (didMethod !== "web" && didMethod !== "plc")
    return error(
      400,
      `Invalid DID method: '${did}'. Expected either 'web' or 'plc'`
    );

  return {
    publicKey: await getPublicKey(did),
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
router.get("/xrpc/chat.roomy.v0.key", ({ did }: Ctx) => getEncodedKeypair(did));

Deno.serve(router.fetch);

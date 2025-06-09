import { AutoRouter, cors, error } from "itty-router";
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver } from "@atproto/identity";
import { WasmCrypto } from "cojson/crypto/WasmCrypto";
import {
  InMemoryKVStore,
  AuthSecretStorage,
  KvStoreContext,
  CryptoProvider,
  PassphraseAuth,
} from "jazz-tools";
import { wordlist } from "./wordlist.ts";

// Initialize just enough of the Jazz context to instantiate a PassphraseAuth instance we can use to
// generate passphrases.
KvStoreContext.getInstance().initialize(new InMemoryKVStore());
const authSecretStorage = new AuthSecretStorage();
// deno-lint-ignore no-explicit-any
const crypto = (await WasmCrypto.create()) as CryptoProvider<any>;
const auth = new PassphraseAuth(
  crypto,
  async () => {},
  () => {
    return Promise.resolve("");
  },
  authSecretStorage,
  wordlist
);

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
function generatePassphrase(): string {
  return auth.generateRandomPassphrase();
}
async function getPassphrase(did: string): Promise<string> {
  const entry = await db.get<string>(["passphrases", did]);
  if (entry.value) {
    return entry.value;
  }
  const newKeypair = generatePassphrase();
  await db.set(["passphrases", did], newKeypair);
  return newKeypair;
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

// Get the user's personal passphrase
router.get("/xrpc/chat.roomy.v1.passphrase", ({ did }: Ctx) =>
  getPassphrase(did)
);

Deno.serve(router.fetch);

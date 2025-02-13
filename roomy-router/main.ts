import { AutoRouter, cors, error } from "itty-router";
import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver } from "@atproto/identity";
import encodeBase32 from "base32-encode";
import { AtprotoHandleResolver } from "@atproto-labs/handle-resolver";
import { ulid } from "ulidx";
import {
  encodeRawMessage,
  parsePeerMessage,
  type RouterMessageHeader,
} from "./encoding.ts";

// Open the key-value database
const kv = await Deno.openKv();

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

// Create HTTP router
const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

// Parse configuration environment variables.
const serviceDid = Deno.env.get("DID");
const serviceEndpoint = Deno.env.get("PUBLIC_URL");
const unsafeDevToken = Deno.env.get("UNSAFE_DEV_TOKEN");

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
      id: "#roomy_router",
      type: "RoomyRouter",
      serviceEndpoint: (() => {
        if (serviceEndpoint) return serviceEndpoint;
        const u = new URL(url);
        u.pathname = "/";
        return u.href;
      })(),
    },
  ],
}));

function getOrDefault<K, V>(map: Map<K, V>, key: K, defaultValue: V): V {
  if (!map.has(key)) {
    map.set(key, defaultValue);
  }
  return map.get(key)!;
}

type DocId = string;
type Ulid = string;
const globalInterests: Map<DocId, Set<Ulid>> = new Map();
const globalConnections: Map<Ulid, Connection> = new Map();

/** Handles the connection to a peer. */
class Connection {
  /** The websocket backing the connection */
  socket: WebSocket;
  /** The DID of the authenticated user of the connection. */
  did: string;
  /** The connection's unique ID. */
  connId: Ulid;
  /** the list of document IDs that this connection is interested in. */
  interests: Set<DocId> = new Set();

  constructor(did: string, connId: string, socket: WebSocket) {
    this.did = did;
    this.connId = connId;
    this.socket = socket;
    this.socket.binaryType = "arraybuffer";

    socket.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.#handleMessage(e.data);
      } else if (typeof e.data == "string") {
        this.#handleMessage(new TextEncoder().encode(e.data));
      }
    });
  }

  #handleMessage(buffer: ArrayBuffer) {
    const msg = parsePeerMessage(buffer);
    if (msg instanceof Error) {
      console.warn(`Error parsing message for ${this.did}`);
      return;
    }
    const [header, data] = msg;

    // Set the documents that we are listening to
    if (header[0] == "listen") {
      const newInterests = new Set(header.slice(1));

      // Remove any of the removed interests from the global interests list
      const removedInterests = this.interests.difference(newInterests);
      for (const docId of removedInterests) {
        // Get the list of connections interested in this document
        const interestedConnections = getOrDefault(
          globalInterests,
          docId,
          new Set()
        );
        // Remove this connection from those interested in this doc
        interestedConnections.delete(this.connId);
        // For every _other_ connection interested in this doc
        for (const interestedConnectionId of interestedConnections) {
          // Get the connection
          const connection = globalConnections.get(interestedConnectionId);
          if (connection) {
            // And tell it that we are leaving the document
            connection.sendHeader(["leave", this.did, this.connId, docId]);
          } else {
            // Shouldn't happen, but just in case.
            globalConnections.delete(interestedConnectionId);
          }
        }
      }

      // Add any new interests
      const addedInterests = newInterests.difference(this.interests);
      // For every added document we are interested in
      for (const docId of addedInterests) {
        const interestedConnections = getOrDefault(
          globalInterests,
          docId,
          new Set()
        );
        // For every other connection that is interested
        for (const interestedConnectionId of interestedConnections) {
          // Get the connection
          const connection = globalConnections.get(interestedConnectionId);
          if (connection) {
            // And tell it that we are joining the document
            connection.sendHeader(["join", this.did, this.connId, docId]);

            // Also tell this peer about the other peer with the same interest
            this.sendHeader(["join", connection.did, connection.connId, docId]);
          } else {
            // Shouldn't happen, but just in case
            globalConnections.delete(interestedConnectionId);
          }
        }

        // Add our connection to the list of those interested
        interestedConnections.add(this.connId);
      }

      // Update interests
      this.interests = newInterests;
    }

    // Sending another peer a message
    else if (header[0] == "send") {
      const [_, did, connId, docId] = header;
      if (did !== this.did || connId !== this.connId) {
        // Get the connection we are trying to send to
        const connection = globalConnections.get(connId);
        if (!connection) return;
        if (connection.did != did) return; // Don't send message if DID is unexpected.

        // Send data
        connection.sendData(this.did, this.connId, docId, data);
      }
    }
  }

  sendHeader(header: RouterMessageHeader) {
    this.socket.send(
      encodeRawMessage<RouterMessageHeader>({
        // Send join or leave message based on whether other peer is connected
        header,
        body: new Uint8Array(),
      })
    );
  }

  /** Send a message to this peer. */
  sendData(fromDid: string, connId: string, docId: DocId, data: Uint8Array) {
    this.socket.send(
      encodeRawMessage<RouterMessageHeader>({
        header: ["send", fromDid, connId, docId],
        body: data,
      })
    );
  }
}

// Open a websocket connection to the routing service.
router.get("/connect/as/:did", async (req) => {
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

  // Generate a connection ID
  const connId = ulid();

  // Upgrade to websocket connection
  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: "authorization",
  });

  socket.addEventListener("open", () => {
    // Add new connection to the connection list
    const connection = new Connection(did, connId, socket);
    console.info(`Peer connected   : ${did}(${connId})`);
    globalConnections.set(connId, connection);
  });

  socket.addEventListener("close", () => {
    const connection = globalConnections.get(connId);
    if (!connection) return;

    // Loop over documents that we were interested in
    for (const docId of connection.interests) {
      // Remove this connection from the interested connections
      globalInterests.get(docId)?.delete(connId);

      // For every other connection interested in this doc
      for (const interestedConnId of globalInterests.get(docId) || new Set()) {
        const connection = globalConnections.get(interestedConnId);
        if (connection) {
          connection.sendHeader(["leave", did, connId, docId]);
        } else {
          globalConnections.delete(interestedConnId);
        }
      }
    }

    console.info(`Peer disconnected: ${did}(${connId})`);
  });

  return response;
});

const resolver = new AtprotoHandleResolver({
  async resolveTxt(hostname) {
    return (await Deno.resolveDns(hostname, "TXT")).flat();
  },
  fetch,
});
router.get("/xrpc/com.atproto.identity.resolveHandle", async ({ query }) => {
  const { handle } = query;
  if (typeof handle !== "string" || !handle)
    return error(400, "handle query parameter required");
  const did: string | null = await resolver.resolve(handle);
  if (!did) return error(404, `Could not resolve handle to DID: ${handle}`);
  return { did };
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
router.get("/xrpc/chat.roomy.v0.router.token", async ({ did }: Ctx) => {
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

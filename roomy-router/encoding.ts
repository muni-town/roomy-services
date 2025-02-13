import { z } from "zod";

export type RouterMessageHeader = z.infer<typeof routerMessageHeader>;
export const routerMessageHeader = z.union([
  z.tuple([
    // The kind of message
    z.literal("join"),
    // The DID of the peer involved
    z.string(),
    // The connection ID involved
    z.string(),
    // The document ID that they are joining
    z.string(),
  ]),
  z.tuple([
    // The kind of message
    z.literal("leave"),
    // The DID of the peer involved
    z.string(),
    // The connection that has left ( or all of them if null)
    z.string(),
    // The document ID that they are leaving ( or all of them if null )
    z.string(),
  ]),
  z.tuple([
    // The kind of message
    z.literal("send"),
    // The DID of the peer involved
    z.string(),
    // The connection ID involved
    z.string(),
    // The document ID the message is about
    z.string(),
  ]),
]);

export type PeerMessageHeader = z.infer<typeof peerMessageHeader>;
export const peerMessageHeader = z.union([
  // Sets the DocIds that this peer is interested in getting "join" and "leave" messages from.
  z.tuple([z.literal("listen")]).rest(z.string()),
  // Sends a message to another peer's ( did, connectionId )
  z.tuple([
    z.literal("send"),
    // The other peer's DID
    z.string(),
    // The other peer's connection ID
    z.string(),
    // The DocID the message is about
    z.string(),
  ]),
]);

export type RawMessage<T> = {
  header: T;
  body: Uint8Array;
};

const sizeOfU32 = 4;

export function parseRawMessage<T>(data: ArrayBuffer): RawMessage<T> {
  const headerLength = new DataView(data).getUint32(0, true);
  const headerSlice = data.slice(sizeOfU32, sizeOfU32 + headerLength);
  const headerTxt = new TextDecoder().decode(headerSlice);
  const header = JSON.parse(headerTxt) as T;

  return {
    header,
    body: new Uint8Array(data.slice(sizeOfU32 + headerLength)),
  };
}

export function encodeRawMessage<T>(message: RawMessage<T>): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(message.header));
  const headerLength = header.length;
  const encodedLength = sizeOfU32 + headerLength + message.body.length;
  const encoded = new Uint8Array(encodedLength);
  new DataView(encoded.buffer).setUint32(0, headerLength, true);
  encoded.set(header, sizeOfU32);
  encoded.set(message.body, sizeOfU32 + headerLength);
  return encoded.buffer;
}

export function parseMessageWithSchema<T>(
  schema: z.ZodType<T>,
  data: ArrayBuffer
): [T, Uint8Array] | Error {
  const errorMsg = "Error parsing peer message";
  let rawMessage: RawMessage<T>;
  try {
    rawMessage = parseRawMessage(data);
  } catch (_) {
    return new Error(errorMsg);
  }
  const header = schema.safeParse(rawMessage.header);
  if (header.error || !header.data)
    return new Error(`${errorMsg}: ${header.error}`);

  return [header.data, rawMessage.body];
}

export function parsePeerMessage(
  data: ArrayBuffer
): [PeerMessageHeader, Uint8Array] | Error {
  return parseMessageWithSchema(peerMessageHeader, data);
}

export function parseRouterMessage(
  data: ArrayBuffer
): [RouterMessageHeader, Uint8Array] | Error {
  return parseMessageWithSchema(routerMessageHeader, data);
}

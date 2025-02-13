import {
  encodeRawMessage,
  parseRouterMessage,
  type PeerMessageHeader,
} from "./encoding.ts";
import { TypedEventTarget } from "@derzade/typescript-event-target";

function getOrDefault<K, V>(map: Map<K, V>, key: K, defaultValue: V): V {
  if (!map.has(key)) {
    map.set(key, defaultValue);
  }
  return map.get(key)!;
}

export class JoinEvent extends Event {
  did: string;
  connId: string;
  docId: string;
  constructor(did: string, connId: string, docId: string) {
    super("join");
    this.did = did;
    this.connId = connId;
    this.docId = docId;
  }
}

export class LeaveEvent extends Event {
  did: string;
  connId: string;
  docId: string;
  constructor(did: string, connId: string, docId: string) {
    super("leave");
    this.did = did;
    this.connId = connId;
    this.docId = docId;
  }
}

export class DataEvent extends Event {
  did: string;
  connId: string;
  docId: string;
  data: Uint8Array;
  constructor(did: string, connId: string, docId: string, data: Uint8Array) {
    super("data");
    this.did = did;
    this.connId = connId;
    this.docId = docId;
    this.data = data;
  }
}

export interface RouterClientEventMap {
  open: Event;
  close: Event;
  join: JoinEvent;
  leave: LeaveEvent;
  data: DataEvent;
  error: Event;
}

export interface Member {
  did: string;
  connId: string;
}

export type DocId = string;

export class RouterClient extends TypedEventTarget<RouterClientEventMap> {
  socket: WebSocket;
  open: Promise<void>;
  #interests: Map<DocId, Member[]> = new Map();

  get interests(): Map<DocId, Member[]> {
    return this.#interests;
  }

  constructor(token: string, url: string) {
    super();

    this.socket = new WebSocket(url, ["authorization", token]);
    this.socket.binaryType = "arraybuffer";

    this.socket.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.#handleMessage(e.data);
      } else if (typeof e.data == "string") {
        this.#handleMessage(new TextEncoder().encode(e.data));
      }
    });
    this.socket.addEventListener("error", (e) => {
      this.dispatchTypedEvent("error", e);
    });
    this.socket.addEventListener("close", () => {
      this.dispatchTypedEvent("close", new Event("close"));
    });

    this.open = new Promise((resolve) => {
      this.socket.addEventListener("open", () => {
        this.dispatchTypedEvent("open", new Event("open"));
        resolve();
      });
    });
  }

  removeInterests(...docIds: DocId[]) {
    for (const docId of docIds) {
      if (!this.#interests.has(docId)) this.#interests.delete(docId);
    }

    this.socket.send(
      encodeRawMessage<PeerMessageHeader>({
        header: ["listen", ...this.#interests.keys()],
        body: new Uint8Array(),
      })
    );
  }

  addInterests(...docIds: DocId[]) {
    for (const docId of docIds) {
      if (!this.#interests.has(docId)) this.#interests.set(docId, []);
    }

    this.socket.send(
      encodeRawMessage<PeerMessageHeader>({
        header: ["listen", ...this.#interests.keys()],
        body: new Uint8Array(),
      })
    );
  }

  send(did: string, connId: string, docId: DocId, data: Uint8Array) {
    this.socket.send(
      encodeRawMessage<PeerMessageHeader>({
        header: ["send", did, connId, docId],
        body: data,
      })
    );
  }

  #handleMessage(buffer: ArrayBuffer) {
    const msg = parseRouterMessage(buffer);
    if (msg instanceof Error) {
      console.warn(`Error parsing router message.`);
      return;
    }
    const [header, data] = msg;

    if (header[0] == "join") {
      const [_, did, connId, docId] = header;
      const interestedConnections = getOrDefault(this.#interests, docId, []);
      interestedConnections.push({ connId, did });
      this.dispatchTypedEvent("join", new JoinEvent(did, connId, docId));
    } else if (header[0] == "leave") {
      const [_, did, connId, docId] = header;
      const interestedConnections = getOrDefault(this.#interests, docId, []);
      this.#interests.set(
        docId,
        interestedConnections.filter(
          (x) => x.connId !== connId || x.did !== did
        )
      );
      this.dispatchTypedEvent("leave", new LeaveEvent(did, connId, docId));
    } else if (header[0] == "send") {
      const [_, did, connId, docId] = header;
      this.dispatchTypedEvent("data", new DataEvent(did, connId, docId, data));
    }
  }
}

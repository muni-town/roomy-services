import * as a from "@automerge/automerge";
import { HeadSyncer, PartialChange } from "./head-syncer.ts";
import { assertEquals } from "@std/assert/equals";

class Peer<T> {
  doc: a.Doc<T>;
  peerId: string;

  constructor(doc: a.Doc<T>, peerId: string) {
    this.doc = doc;
    this.peerId = peerId;
  }

  clone(peerId: string): Peer<T> {
    return new Peer(a.clone(this.doc), peerId);
  }

  change(change: a.ChangeFn<T>): Peer<T> {
    this.doc = a.change(this.doc, change);
    return this;
  }

  merge(doc: a.Doc<T> | Peer<T>): Peer<T> {
    if ("doc" in doc) {
      this.doc = a.merge(this.doc, doc.doc);
    } else {
      this.doc = a.merge(this.doc, doc);
    }
    return this;
  }

  heads(): a.Heads {
    return a.getHeads(this.doc);
  }

  partialChanges(): PartialChange[] {
    return a
      .getAllChanges(this.doc)
      .map(a.decodeChange)
      .map((x) => ({ hash: x.hash, deps: x.deps }));
  }

  syncHeads(syncer: HeadSyncer) {
    syncer.ingestChanges(this.peerId, this.partialChanges());
  }
}

Deno.test("head syncer syncs", async () => {
  let data = undefined as undefined | Uint8Array;
  const storage = {
    load() {
      return Promise.resolve(data);
    },
    save(d) {
      data = d;
      return Promise.resolve();
    },
  } satisfies Parameters<typeof HeadSyncer.init>[0];
  const syncer = await HeadSyncer.init(storage);

  // Start with all peers in a common state
  let p1 = new Peer(
    a.from({
      messages: ["first message"] as string[],
    }),
    "p1"
  );
  const p2 = p1.clone("p2");
  const p3 = p1.clone("p3");
  const p4 = p1.clone("p4");
  const p5 = p1.clone("p5");

  // Then all peers make their own changes independetly
  p1.change((doc) => doc.messages.push("p1 says hello"));
  p2.change((doc) => doc.messages.push("p2 says hello"));
  p3.change((doc) => doc.messages.push("p3 says hello"));
  p4.change((doc) => doc.messages.push("p4 says hello"));

  // All peers then sync with the syncer
  p1.syncHeads(syncer);
  p2.syncHeads(syncer);
  p3.syncHeads(syncer);
  p4.syncHeads(syncer);

  // And if we ask which peers we need to sync with it shows that all of them have data that we need
  // to get the full picture.
  assertEquals(["p1", "p2", "p3", "p4"], syncer.calculatePeersToDownloadFrom());

  // Now p1 syncs with the rest of the peers
  p1 = p1.merge(p2).merge(p3).merge(p4);
  // And updates the syncer
  p1.syncHeads(syncer);

  // Now that p1 has all the latest heads we only need to sync with it to get all the latest changes
  assertEquals(["p1"], syncer.calculatePeersToDownloadFrom());

  // Now p2 syncs with p1
  p2.merge(p1);
  // And p2 adds it's own change
  p2.change((doc) => doc.messages.push("p2 likes pizza"));
  // And syncs heads
  p2.syncHeads(syncer);

  // Now p2 has the latest heads
  assertEquals(["p2"], syncer.calculatePeersToDownloadFrom());

  // Having p3 and p4 sync again doesn't change anything
  p3.syncHeads(syncer);
  p4.syncHeads(syncer);
  assertEquals(["p2"], syncer.calculatePeersToDownloadFrom());

  // Now if p3 adds their own change
  p3.change((doc) => doc.messages.push("p3 likes oranges"));
  p3.syncHeads(syncer);

  // p3 and p2 have the latest changes
  assertEquals(
    new Set(["p3", "p2"]),
    new Set(syncer.calculatePeersToDownloadFrom())
  );

  // Now p5 comes out of nowhere and adds his messge
  p5.change((doc) => doc.messages.push("p5 hasn't seen other messages yet."));
  p5.syncHeads(syncer);

  // We must now sync with p3, p2, and p5
  assertEquals(
    new Set(["p2", "p5", "p3"]),
    new Set(syncer.calculatePeersToDownloadFrom())
  );

  // finally, p4 comes and syncs with p2, p5, and p3
  p4.merge(p2).merge(p5).merge(p3);
  p4.syncHeads(syncer);
  assertEquals(["p4"], syncer.calculatePeersToDownloadFrom());

  assertEquals(syncer, await HeadSyncer.init(storage));
});

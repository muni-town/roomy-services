import { Heads } from "@automerge/automerge";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";

export const partialChange = z.object({
  hash: z.string(),
  deps: z.array(z.string()),
});
export type PartialChange = z.infer<typeof partialChange>;

function getOrDefault<K, V>(map: Map<K, V>, key: K, def: V): V {
  const existing = map.get(key);
  if (existing) return existing;
  map.set(key, def);
  return map.get(key)!;
}

type ChangeGraphPojo = {
  nodes: { [key: string]: string[] };
  missing: string[];
  heads: string[];
};
type AddChangeResult =
  | { type: "new_head"; removedHeads: string[]; missingDeps: string[] }
  | { type: "already_exists" }
  | { type: "was_missing" };
class ChangeGraph {
  /** Mapping of change hashes to the dependencies of that hash. */
  nodes: Map<string, string[]>;
  /** The list of changes that we have seen in dependencies of other changes, but don't actually
   * have yet. */
  missing: Set<string>;
  /** The cache of the latest heads of the graph, i.e. nodes that don't have anything depending on
   * them. */
  heads: Set<string>;

  constructor(pojo?: ChangeGraphPojo) {
    if (pojo) {
      this.nodes = new Map(Object.entries(pojo.nodes));
      this.heads = new Set(pojo.heads);
      this.missing = new Set(pojo.missing);
    } else {
      this.nodes = new Map();
      this.heads = new Set();
      this.missing = new Set();
    }
  }

  pojo(): ChangeGraphPojo {
    return {
      nodes: Object.fromEntries(this.nodes.entries()),
      heads: Array.from(this.heads),
      missing: Array.from(this.missing),
    };
  }

  addChange(change: PartialChange): AddChangeResult {
    // Skip changes that we already have
    if (this.nodes.has(change.hash)) return { type: "already_exists" };

    // Insert the change into the list
    this.nodes.set(change.hash, change.deps);

    if (this.missing.has(change.hash)) {
      // If this was a missing node, we know that it is not a head, and that it is no longer missing.
      this.missing.delete(change.hash);
      return { type: "was_missing" };
    } else {
      // If this change is not a previously missing node, then it is a new head
      this.heads.add(change.hash);

      const removedHeads: string[] = [];
      const missingDeps: string[] = [];
      new Set(change.deps).forEach((dep) => {
        // Remove any dependencies of this change from heads, as they are no longer heads
        if (this.heads.has(dep)) {
          this.heads.delete(dep);
          removedHeads.push(dep);
        }

        // If any of our dependencies are missing, add them to the missing list
        if (!this.nodes.has(dep)) {
          this.missing.add(dep);
          missingDeps.push(dep);
        }
      });

      return { type: "new_head", missingDeps, removedHeads };
    }
  }
}

export interface SyncerStorage {
  save(data: Uint8Array): Promise<void>;
  load(): Promise<Uint8Array | undefined>;
}

type HeadSyncerPojo = {
  changes: ChangeGraphPojo;
  headPeers: { [id: string]: string[] };
};
export class HeadSyncer {
  /** The graph of known change hashes and how they depend on each-other. */
  changes: ChangeGraph;

  /** The list of every peer known to have a given head. */
  headPeers: Map<string, Set<string>>;

  /** The storage used to load and save the syncer state. */
  storage: SyncerStorage;

  private constructor(
    storage: SyncerStorage,
    changes: ChangeGraph,
    headPeers: Map<string, Set<string>>
  ) {
    this.storage = storage;
    this.changes = changes;
    this.headPeers = headPeers;
  }

  static async init(storage: SyncerStorage): Promise<HeadSyncer> {
    const loaded = await storage.load();
    const data: HeadSyncerPojo = loaded
      ? JSON.parse(new TextDecoder().decode(inflateSync(loaded)))
      : undefined;
    const changes = new ChangeGraph(data?.changes);
    const headPeers: Map<string, Set<string>> = data?.headPeers
      ? new Map(Object.entries(data.headPeers).map(([k, v]) => [k, new Set(v)]))
      : new Map();
    return new HeadSyncer(storage, changes, headPeers);
  }

  getPeerHeads(id: string): Heads {
    const heads = this.headPeers.get(id);
    return heads ? Array.from(heads) : [];
  }

  getLatestHeads(): Heads {
    return Array.from(this.changes.heads);
  }

  pojo(): HeadSyncerPojo {
    return {
      changes: this.changes.pojo(),
      headPeers: Object.fromEntries(
        this.headPeers.entries().map(([k, v]) => [k, Array.from(v)])
      ),
    };
  }

  async ingestChanges(peer: string, changes: PartialChange[]): Promise<void> {
    for (const change of changes) {
      // Add the change to our change list
      const result = this.changes.addChange(change);

      // If this change was a new head
      if (result.type == "new_head") {
        // Make sure we record it in the list of peers that have a head.
        const peers = getOrDefault(this.headPeers, change.hash, new Set());
        peers.add(peer);

        // Also remove any old heads from our list of peers with heads.
        for (const removedHeads of result.removedHeads) {
          this.headPeers.delete(removedHeads);
        }

        // If this change already existed, and it was a head
      } else if (
        result.type == "already_exists" &&
        this.changes.heads.has(change.hash)
      ) {
        // Add this peer to the list of peers with the head.
        const peers = getOrDefault(this.headPeers, change.hash, new Set());
        peers.add(peer);
      }
    }

    // Save syncer to storage
    await this.storage.save(
      deflateSync(new TextEncoder().encode(JSON.stringify(this.pojo())))
    );
  }

  /** Find the shortest list of peers that collectively have all of the latest heads. */
  calculatePeersToDownloadFrom(): string[] {
    let headsRemaining = new Set(this.changes.heads);

    // The list of peers to sync with to get all latest heads
    const peersToSync = [];

    // Get the list of every peer and the heads that it contains
    const peerHeads: Map<string, Set<string>> = new Map();
    for (const [head, peers] of this.headPeers) {
      for (const peer of peers) {
        const heads = getOrDefault(peerHeads, peer, new Set());
        heads.add(head);
      }
    }

    while (headsRemaining.size > 0) {
      // Track the peer with the most intersections
      let peerWithMostHeads = undefined as
        | undefined
        | { peer: string; intersection: Set<string> };

      // Try every peer
      for (const [peer, heads] of peerHeads) {
        const intersection = heads.intersection(headsRemaining);
        if (intersection.size > (peerWithMostHeads?.intersection.size || 0)) {
          peerWithMostHeads = { peer, intersection };
        }
      }

      if (!peerWithMostHeads)
        throw "Error in calculatePeersToDownloadFrom() algorithm: didn't find any peer with heads.";

      // Add this peer to the list of peers to sync with
      peersToSync.push(peerWithMostHeads.peer);

      // Update the remaining heads
      headsRemaining = headsRemaining.difference(
        peerWithMostHeads.intersection
      );
    }

    return peersToSync;
  }
}

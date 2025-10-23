import { simpleGit } from "simple-git";
import { eventCodec } from "./encoding.ts";
import { AtpAgent } from "@atproto/api";
import { LeafClient } from "@muni-town/leaf-client";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ulid, isValid as isValidUlid } from "ulidx";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import {
  patchApply,
  patchFromText,
  patchMake,
  patchToText,
} from "diff-match-patch-es";
import { locks } from "node:worker_threads";

if (
  process.env["HTTP_PROXY"] ||
  process.env["HTTPS_PROXY"] ||
  process.env["NO_PROXY"]
) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const gitExperimental2WayEnv = "ENABLE_EXPERIMENTAL_2WAY_SYNC";
const gitRemoteEnv = "GIT_REMOTE";
const leafServerEnv = "LEAF_SERVER";
const usernameEnv = "ATPROTO_USERNAME";
const passwordEnv = "ATPROTO_APP_PASSWORD";
const leafStreamEnv = "ROOMY_SPACE";
const gitEmailEnv = "GIT_EMAIL";
const gitNameEnv = "GIT_NAME";
const username = process.env[usernameEnv];
const leafServer = process.env[leafServerEnv] || "https://leaf.muni.town";
const password = process.env[passwordEnv];
const gitExperimental2Way = !!process.env[gitExperimental2WayEnv];
const leafStream = process.env[leafStreamEnv];
const gitRemote = process.env[gitRemoteEnv];
const gitEmail = process.env[gitEmailEnv];
const gitName = process.env[gitNameEnv];

if (!username) throw `${usernameEnv} env var required.`;
if (!password) throw `${passwordEnv} env var required.`;
if (!leafStream) throw `${leafStreamEnv} env var required.`;

const GIT_REMOTE_NAME = "roomy";
const BASE_DIR = "./git";
const skipListFilePath = `${BASE_DIR}/skipList`;
/** The checkpoint tag is a tag that marks the latest point at which we know we are up to date with remote changes */
const CHECKPOINT_TAG = "checkpoint";

const MATERIALIZER_LOCK = "materializer-lock";

const needsInit = !existsSync(`${BASE_DIR}/.git`);

if (needsInit) {
  try {
    await mkdir(BASE_DIR);
  } catch (_e) {
    // Ignore if the directory already exists
  }
}

const repo = simpleGit({ baseDir: BASE_DIR });

if (needsInit) {
  await repo.init(["--initial-branch=main"]);
  await writeFile(
    `${BASE_DIR}/README.md`,
    "# Roomy Backup Dir\n\nThis repo is a backup directory for a roomy space."
  );
  await repo.add(".").commit("Initial Commit").tag(["-f", CHECKPOINT_TAG]);
  if (gitRemote) {
    await repo.push(GIT_REMOTE_NAME, "main", ["--force", "--tags"]);
  }
}

if (gitRemote) {
  const existingRemotes = await repo.getRemotes();
  if (!existingRemotes.find((x) => x.name == "roomy")) {
    await repo.addRemote(GIT_REMOTE_NAME, gitRemote);
  }
}

if (gitEmail) repo.addConfig("user.email", gitEmail);
if (gitName) repo.addConfig("user.name", gitName);

const agent = new AtpAgent({ service: "https://bsky.social" });
await agent.login({
  identifier: username,
  password,
});
console.log(`Logged into ATProto as ${agent.assertDid}`);

const leaf = new LeafClient(leafServer, async () => {
  const resp = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${new URL(leafServer).host}`,
  });
  if (!resp) throw "Error authenticating for leaf server";
  return resp.data.token;
});

const latestEventFilePath = `${BASE_DIR}/latestEvent`;
const latestEventFile = await open(
  latestEventFilePath,
  existsSync(latestEventFilePath) ? "r+" : "w+"
);
const latestEventFileContents = await latestEventFile.readFile({
  encoding: "utf8",
});
const latestEvent = parseInt(latestEventFileContents || "0");

console.log("Latest event at startup:", latestEvent);

leaf.on("disconnect", () => {
  console.log("disconnected");
});
leaf.on("error", (e) => {
  console.log("Leaf error:", e);
});

type IncomingEvent = {
  idx: number;
  user: string;
  payload: Buffer | ArrayBuffer;
};
let backfilling = true;
let backfillQueue: IncomingEvent[] = [];
leaf.on("authenticated", async () => {
  console.log("Authenticated");
  await leaf.subscribe(leafStream);

  backfilling = true;
  console.log("backfilling...");

  const batchSize = 2000;
  let offset = latestEvent + 1;
  let updates = 0;
  while (true) {
    const rawEvents = await leaf.fetchEvents(leafStream, {
      offset,
      limit: batchSize,
    });
    if (rawEvents.length == 0) break;

    updates += await materializeEvents(rawEvents);

    offset = rawEvents[rawEvents.length - 1].idx + 1;
  }

  while (backfillQueue.length > 0) {
    const events = [...backfillQueue];
    backfillQueue = [];
    updates += await materializeEvents(events);
  }

  if (gitRemote) {
    // Even though there might not have been updates, push anyway, just in case updates from previous
    // runs weren't pushed yet.
    console.log("Pushing...");
    try {
      await repo.pull(GIT_REMOTE_NAME, "main", ["--rebase"]);
    } catch (e) {
      console.warn(
        "Warning while pulling repo. It might be normal so ignoring.",
        e
      );
    }
    await repo.push(GIT_REMOTE_NAME, "main", ["--tags", "--force"]);
    console.log("pushed");
  }

  console.log(`done backfilling ${updates} new updates.`);
  backfilling = false;
});

async function materializeEvents(rawEvents: IncomingEvent[]): Promise<number> {
  return locks.request(MATERIALIZER_LOCK, async () => {
    const events = rawEvents
      .map((x) => ({
        ...x,
        payload: eventCodec.dec(new Uint8Array(x.payload)),
      }))
      .map((x) => {
        if (x.payload.variant.kind == "space.roomy.page.edit.0") {
          const content = x.payload.variant.data.content;
          return {
            idx: x.idx,
            user: x.user,
            docId: x.payload.parent,
            eventId: x.payload.ulid,
            content: new TextDecoder().decode(content.content),
            mimeType: content.mimeType,
          };
        } else {
          return;
        }
      })
      .filter((x) => !!x);

    const skipList = existsSync(skipListFilePath)
      ? new Set(
          (await readFile(skipListFilePath, { encoding: "utf8" }))
            .split("\n")
            .filter((x) => !!x && isValidUlid(x))
        )
      : new Set();
    console.log("skipList", [...skipList.values()]);

    let edits = 0;
    for (const event of events) {
      console.log("Processing event", event.eventId);
      if (skipList.has(event.eventId)) {
        console.log("Skipping event because it's in skip list");
        skipList.delete(event.eventId);

        await latestEventFile.truncate();
        await latestEventFile.write(event.idx.toString(), 0, "utf8");
        await latestEventFile.sync();
        await writeFile(skipListFilePath, [...skipList.values()].join("\n"));
        await repo.add(".").commit(`acknowledge event ${event.idx} from git`);
        continue;
      }

      const filename = `${BASE_DIR}/${event.docId}.md`;
      if (event.mimeType == "text/x-dmp-patch") {
        console.log(`Patching ${filename}`);
        const currentContent = await readFile(filename, {
          encoding: "utf8",
        });
        const [newContent] = patchApply(
          patchFromText(event.content),
          currentContent
        ) as [string, boolean[]];
        await writeFile(filename, newContent, { encoding: "utf8" });
      } else {
        console.log(`Creating ${filename}`);
        await writeFile(filename, event.content, { encoding: "utf8" });
      }

      await latestEventFile.truncate();
      await latestEventFile.write(event.idx.toString(), 0, "utf8");
      await latestEventFile.sync();

      const commitMessage = `Update ${filename}\n\nAuthor: ${event.user}\n\nEvent Index: ${event.idx}`;
      console.log("Committing:", commitMessage);
      await repo.add(".").commit(commitMessage);
      edits += 1;
    }

    return edits;
  });
}

leaf.on("event", async (event) => {
  console.log("new event", event.idx);
  if (backfilling) {
    backfillQueue.push(event);
  } else {
    const changes = await materializeEvents([event]);

    if (changes > 0 && gitRemote) {
      console.log("Pushing...");
      try {
        await repo.pull(GIT_REMOTE_NAME, "main", ["--rebase"]);
      } catch (e) {
        console.warn(
          "Warning while pulling repo. It might be normal so ignoring.",
          e
        );
      }
      await repo.push(GIT_REMOTE_NAME, "main", ["--tags", "--force"]);
      console.log("pushed");
    }
  }
});

if (gitExperimental2Way) {
  // Check for updates from git and sync back to roomy periodically
  setInterval(async () => {
    if (!leaf.socket.connected || !gitRemote) return;

    locks.request(MATERIALIZER_LOCK, async () => {
      console.log("Pulling updates");
      await repo.pull(GIT_REMOTE_NAME, "main", ["--rebase"]);

      console.log("Checking for commits we didn't make");
      const latestCheckpoint = await repo.revparse(CHECKPOINT_TAG);

      // Get the whole list of commits since the latest checkpoint
      const commitsSinceCheckpoint = new Set(
        (await repo.log({ to: latestCheckpoint })).all.map((x) => x.hash)
      );
      // Get the list of commits that have updated our latest event file, and therefore don't need to be
      // synced back to roomy.
      const commitsByUsSinceCheckpoint = new Set(
        (await repo.log({ to: latestCheckpoint, file: "latestEvent" })).all.map(
          (x) => x.hash
        )
      );

      const commitsNotByUsSinceCheckpoint = commitsSinceCheckpoint.difference(
        commitsByUsSinceCheckpoint
      );

      if (commitsNotByUsSinceCheckpoint.size) {
        console.log(
          "Found the following new commits we didn't make:",
          [...commitsNotByUsSinceCheckpoint.values()].join("\n")
        );
      }

      for (const commit of commitsNotByUsSinceCheckpoint.values()) {
        const changedFiles = (
          await repo.raw([
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit,
          ])
        ).split("\n");

        const skipListFile = await open(skipListFilePath, "a");
        for (const file of changedFiles) {
          const docId = file.split(".")[0];
          if (!isValidUlid(docId)) continue;

          console.log(
            `Creating patch for ${file} and sending it to the leaf server.`
          );
          const previousVersion = await repo.show([`${commit}^:${file}`]);
          const newVersion = await repo.show([`${commit}:${file}`]);
          const patch = patchToText(patchMake(previousVersion, newVersion));

          const updateId = ulid();
          await leaf.sendEvent(
            leafStream,
            Buffer.from(
              eventCodec.enc({
                ulid: updateId,
                parent: docId,
                variant: {
                  kind: "space.roomy.page.edit.0",
                  data: {
                    content: {
                      mimeType: "text/x-dmp-patch",
                      content: new TextEncoder().encode(patch),
                    },
                  },
                },
              })
            ) as any
          );

          await skipListFile.writeFile(`\n${updateId}`);
          await skipListFile.sync();
        }
        await skipListFile.close();

        await repo
          .add(".")
          .commit("update skiplist")
          .tag(["-f", CHECKPOINT_TAG]);
      }
    });
  }, 10000);
}

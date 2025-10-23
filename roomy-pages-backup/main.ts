import { simpleGit } from "simple-git";
import { eventCodec } from "./encoding.ts";
import { AtpAgent } from "@atproto/api";
import { LeafClient } from "@muni-town/leaf-client";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { patchApply, patchFromText } from "diff-match-patch-es";

if (
  process.env["HTTP_PROXY"] ||
  process.env["HTTPS_PROXY"] ||
  process.env["NO_PROXY"]
) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

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
const leafStream = process.env[leafStreamEnv];
const gitRemote = process.env[gitRemoteEnv];
const gitEmail = process.env[gitEmailEnv];
const gitName = process.env[gitNameEnv];

if (!username) throw `${usernameEnv} env var required.`;
if (!password) throw `${passwordEnv} env var required.`;
if (!leafStream) throw `${leafStreamEnv} env var required.`;

const GIT_REMOTE_NAME = "roomy";
const BASE_DIR = "./git";

const needsInit = !existsSync(`${BASE_DIR}/.git`);

if (needsInit) {
  await mkdir(BASE_DIR);
}

const repo = simpleGit({ baseDir: BASE_DIR });

if (needsInit) {
  await repo.init();
  await writeFile(
    `${BASE_DIR}/README.md`,
    "# Roomy Backup Dir\n\nThis repo is a backup directory for a roomy space."
  );
  await repo.add(".").commit("Initial Commit");
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
    aud: `did:web:${new URL(leafServer).hostname}`,
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
  while (true) {
    const rawEvents = await leaf.fetchEvents(leafStream, {
      offset,
      limit: batchSize,
    });
    if (rawEvents.length == 0) break;

    await materializeEvents(rawEvents);

    offset = rawEvents[rawEvents.length - 1].idx + 1;
  }

  let updates = 0;
  while (backfillQueue.length > 0) {
    const events = [...backfillQueue];
    backfillQueue = [];
    updates += await materializeEvents(events);
  }

  if (updates > 0 && gitRemote) {
    console.log("Pushing...");
    await repo.push(GIT_REMOTE_NAME, "main", ["--force"]);
    console.log("pushed");
  }

  console.log(`done backfilling ${updates} new updates.`);
  backfilling = false;
});

async function materializeEvents(rawEvents: IncomingEvent[]): Promise<number> {
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
          content: new TextDecoder().decode(content.content),
          mimeType: content.mimeType,
        };
      } else {
        return;
      }
    })
    .filter((x) => !!x);

  let edits = 0;
  for (const event of events) {
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
}

leaf.on("event", async (event) => {
  console.log("new event", event.idx);
  if (backfilling) {
    backfillQueue.push(event);
  } else {
    const changes = await materializeEvents([event]);

    if (changes > 0 && gitRemote) {
      console.log("Pushing...");
      await repo.push(GIT_REMOTE_NAME, "main", ["--force"]);
      console.log("pushed");
    }
  }
});

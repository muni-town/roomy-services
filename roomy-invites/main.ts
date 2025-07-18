import { AutoRouter, cors, error } from "itty-router";
import { Pow } from "./spow/wasm/spow-server-wasm.js";
import { Group, Account } from "jazz-tools";
import { startWorker } from "jazz-tools/worker";

const challengeTimeoutSeconds = 30;
const kv = await Deno.openKv();

Pow.init_random();

const syncServer = Deno.env.get("SYNCSERVER");
if (!syncServer) throw new Error("Must specify SYNCSERVER env var");

const accountId = Deno.env.get("ACCOUNT_ID");
const accountSecret = Deno.env.get("ACCOUNT_SECRET");
if (!accountSecret || !accountId) {
  throw new Error(
    "Must set ACCOUNT_ID and ACCOUNT_SECRET environment. These can be generated by running `npx jazz-run account create`."
  );
}

const jazz = await startWorker({
  accountID: accountId,
  accountSecret,
  syncServer,
});

// This is a hacky workaround for a Jazz bug that should be removed when possible:
// https://github.com/garden-co/jazz/issues/2630
globalThis.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled rejection:", e.promise);
  e.preventDefault();
});

console.log("Roomy Invites Service Account ID:", jazz.worker.id);

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

router.get("/service-id", () => {
  return new Response(accountId);
});

router.get("/get-challenge", () => {
  const pow = Pow.build_challenge(challengeTimeoutSeconds);
  return new Response(pow);
});

router.post("/add-member/:group/:member", async ({ text, params }) => {
  try {
    const answeredChallenges = "answeredChallenges";
    const challengeAnswer = await text();
    if (!challengeAnswer)
      return error(
        400,
        "POST body required: proof-of-work challenge must be provided."
      );

    const challenge = Pow.validate(challengeAnswer);
    if ((await kv.get<boolean>([answeredChallenges, challenge])).value) {
      return error(400, "Cannot answer same challenge twice.");
    }
    kv.set([answeredChallenges, challenge], true, {
      expireIn: challengeTimeoutSeconds * 1000,
    });

    const group = await Group.load(params.group);
    if (!group) return error(400, "Could not load specified group.");
    const member = await Account.load(params.member);
    if (!member) return error(400, "Could not load specified member.");

    if (group.myRole() != "admin")
      return error(400, "This service is not an admin of the given role.");

    group.addMember(member, "writer");
    await group.waitForSync();

    return { success: true };
  } catch (e) {
    return error(400, "Error adding member to group: " + e);
  }
});

Deno.serve(router.fetch);

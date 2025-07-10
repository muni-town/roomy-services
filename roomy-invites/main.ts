import { AutoRouter, cors, error } from "itty-router";
import { Pow } from "./spow/wasm/spow-server-wasm.js";
import { Group, Account } from "jazz-tools";
import { createWorkerAccount } from "jazz-run/createWorkerAccount";
import { startWorker } from "jazz-tools/worker";

const challengeTimeoutSeconds = 30;
const kv = await Deno.openKv();

Pow.init_random();

const syncServer = Deno.env.get("SYNCSERVER");
if (!syncServer) throw new Error("Must specify SYNCSERVER env var");

const accountId = Deno.env.get("ACCOUNT_ID");
const accountSecret = Deno.env.get("ACCOUNT_SECRET");
if (!accountSecret || !accountId) {
  const workerAccount = await createWorkerAccount({
    name: "Roomy Invites",
    peer: syncServer,
  });
  console.error(
    "Must set ACCOUNT_ID and ACCOUNT_SECRET environment variables. Here is a newly generated account if you are setting up a new server:\n\n" +
      "  ACCOUNT_ID=" +
      JSON.stringify(workerAccount.accountID) +
      "\n" +
      "  ACCOUNT_SECRET=" +
      JSON.stringify(workerAccount.agentSecret) +
      "\n"
  );

  // Just wait forever to avoid a restart loop.
  while (true) {
    await new Promise((r) => setTimeout(r, 10000));
  }
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
  return pow;
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
    return error(400, "Invalid challenge response: " + e);
  }
});

Deno.serve(router.fetch);

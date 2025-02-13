import { parseArgs } from "@std/cli/parse-args";
import { RouterClient } from "./client.ts";
import { Input, Select } from "@cliffy/prompt";

const args = parseArgs(Deno.args, {
  alias: {
    token: "t",
  },
});
const [url] = args._ as [string];
const token = args.token;

console.log(`Connecting to ${url}`);

let error = false;
while (true) {
  error = false;
  const client = new RouterClient(token, url, {
    receive(did, connId, data) {
      console.log(
        `\n← Received Message from ${did}(${connId}): `,
        new TextDecoder().decode(data)
      );
    },
    join(did, connid) {
      console.log(`\n${did}(${connid}) joined`);
    },
    leave(did, connId) {
      console.log(`\n${did}${connId ? `(${connId})` : ""} left.`);
    },
    error(e) {
      console.error(e);
      error = true;
    },
    open() {
      console.log("Connected.");
    },
  });
  await client.open;

  while (!error) {
    console.log("All connections:", client.knownConnections);

    const did = await Input.prompt("Enter DID to send to :");
    if (!did) continue;

    if (!client.listeningTo.includes(did)) {
      client.addInterests(did, ...client.listeningTo);
      client.ask(did);
    }

    if ((client.knownConnections[did] || []).length == 0) {
      console.log(`No known connections for ${did}`);
      continue;
    }

    console.log("Connections:", client.knownConnections[did]);

    const connId = await Select.prompt({
      message: "Enter connection to send to :",
      options: client.knownConnections[did],
    });
    if (!connId) continue;

    const message = await Input.prompt("Enter message to send:");
    if (!message) continue;

    client.send(did, connId, new TextEncoder().encode(message));
  }
}

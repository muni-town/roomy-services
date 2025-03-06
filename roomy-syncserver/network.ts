import { NetworkAdapter, PeerId } from "@automerge/automerge-repo";

export class DenoNetworkAdapter extends NetworkAdapter {
  clients: Map<PeerId, WebSocket>;

  constructor() {
    super();
    this.clients = new Map();
  }

  override send(): void {
    throw new Error("Method not implemented.");
  }

  override connect(): void {}

  override disconnect(): void {
    // TODO
  }

  override isReady(): boolean {
    return true;
  }

  override whenReady(): Promise<void> {
    return Promise.resolve();
  }

  acceptClient(socket: WebSocket) {
    socket.addEventListener("open", () => {
      const firstMessageListener = (ev: MessageEvent) => {
        
      };
      socket.addEventListener("message", firstMessageListener);

      socket.addEventListener("close", () => {});
    });
  }
}

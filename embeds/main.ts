import { actor, setup } from "rivetkit";

export const counter = actor({
  state: { count: 0 },
  actions: {
    increment: (c, x: number) => {
      c.state.count += x;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    },
    multiply: (c, x: number) => {
      c.state.count *= x;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    }
  },
});

export const registry = setup({
  use: { counter },
});

// Exposes Rivet API on /api/rivet/ to communicate with actors
export default registry.serve();

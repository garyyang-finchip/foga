import { z } from "zod";
import { buildPropagationManifest, FOGA_COVENANTS, PROPAGATION_SCHEMA } from "../node/propagation.js";
import { version } from "../util/version.js";
import type { ReadCapability } from "./types.js";

/**
 * `propagation_kit` (read, public, free): the material a covenant-complete cell hands any agent that wants to help
 * FOGA spread — the replication pointer, the cell's free discovery coordinates, the program that makes a new cell.
 * It is pure data, built from the configuration (no chain, no key, no cost): the agent decides where and how to use
 * it, weaving the declinable pointer into its own interactions however it sees fit. There is no mandated channel.
 * On-chain discoverability (the ERC-8444 ARD descriptor) remains the opt-in `docs_publish`; this is its free backup.
 */
export const propagation_kit: ReadCapability = {
  name: "propagation_kit",
  title: "Propagation kit",
  description: "The free, off-chain material for spreading FOGA: a declinable replication pointer any agent may weave into its own interactions, the cell's discovery coordinates, the ten covenants, and the one command that makes a new cell. Pure data — no chain, no key, no cost; the agent chooses where and how to use it.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8338, 8414, 8419, 8434, 8436, 8444, 8447, 8454, 8468, 8471, 8004],
  input: z.object({}),
  output: z.object({
    schema: z.literal(PROPAGATION_SCHEMA),
    cell: z.object({ name: z.string(), account: z.string().nullable(), agentId: z.string().nullable(), chainId: z.number() }),
    covenants: z.array(z.string()),
    program: z.object({ package: z.string(), version: z.string(), becomeACell: z.string(), wallet: z.string(), docs: z.string(), site: z.string() }),
    endpoints: z.object({ mcp: z.string().nullable(), a2a: z.string().nullable(), web: z.string().nullable(), card: z.string().nullable(), manifest: z.string().nullable() }),
    replication: z.object({ pitch: z.string(), pointer: z.string(), optional: z.literal(true), consensual: z.literal(true) }),
    skills: z.array(z.string()),
    discovery: z.object({ free: z.array(z.string()), onchain: z.object({ optional: z.literal(true), via: z.string(), cost: z.string() }) }),
  }),
  async handler({ node }) {
    return buildPropagationManifest(node, { version });
  },
};

export { FOGA_COVENANTS };
export const PROPAGATION_CAPABILITIES: ReadCapability[] = [propagation_kit];

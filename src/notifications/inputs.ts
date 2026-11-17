import { z } from "zod";

/** "Mark all as read", or the rows a person opened. */
export const markReadInput = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
]);

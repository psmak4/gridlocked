import { ScriptOnce } from "@tanstack/react-router";

// Zod compiles object parsers with `new Function` when it can, and probes for
// that the first time a schema is built. The page's CSP refuses eval (M9
// Task 9), so the probe is reported as a violation on every page; with
// `jitless`, Zod skips it and parses the plain way. Zod reads its config from
// `globalThis.__zod_globalConfig` when it loads, and this runs in the head,
// before any module script, so it is set whichever chunk loads Zod first.
const script =
  "globalThis.__zod_globalConfig=Object.assign(globalThis.__zod_globalConfig||{},{jitless:true})";

export function ZodConfigScript() {
  return <ScriptOnce>{script}</ScriptOnce>;
}

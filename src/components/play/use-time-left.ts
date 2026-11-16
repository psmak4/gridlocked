import { useEffect, useState } from "react";
import { systemTimer } from "@/lib/clock";
import { countdownTick } from "./team-words";

/**
 * The milliseconds left to `at` on the server's clock: the page's `now` at
 * first (so the server and the first client render agree), then ticking in
 * the browser by the same offset: real time passing (`systemTimer`) on the
 * server's "now", which a replay sets. Null with no `at`.
 */
export function useTimeLeft(
  at: string | null,
  serverNow: string,
): number | null {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    if (!at) return;
    const offset = Date.parse(serverNow) - systemTimer.now();
    const target = Date.parse(at);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const moment = systemTimer.now() + offset;
      setNow(moment);
      timer = setTimeout(tick, countdownTick(target - moment));
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [at, serverNow]);
  return at ? Date.parse(at) - now : null;
}

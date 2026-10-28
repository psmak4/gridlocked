// Test helper: the recorded 2026 calendar, parsed by the Jolpica adapter. It
// is the one place a src/reference test reaches into src/providers (see the
// override in eslint.config.mjs).
import { parseJolpicaCalendar } from "@/providers/jolpica/calendar";
import type { CalendarEvent } from "@/reference/calendar-types";
import { readFixture } from "./fixtures";

/** A fresh copy each call, so tests can edit it. */
export function loadCalendar2026(): CalendarEvent[] {
  return parseJolpicaCalendar(readFixture("jolpica/2026.json"));
}

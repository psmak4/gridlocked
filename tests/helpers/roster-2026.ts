// Test helper: the recorded 2026 drivers and constructors, parsed by the
// Jolpica adapter (see the override in eslint.config.mjs).
import {
  parseJolpicaConstructors,
  parseJolpicaDrivers,
} from "@/providers/jolpica/roster";
import type { RosterConstructor, RosterDriver } from "@/reference/roster-types";
import { readFixture } from "./fixtures";

export function loadDrivers2026(): RosterDriver[] {
  return parseJolpicaDrivers(readFixture("jolpica/2026/drivers.json"));
}

export function loadConstructors2026(): RosterConstructor[] {
  return parseJolpicaConstructors(
    readFixture("jolpica/2026/constructors.json"),
  );
}

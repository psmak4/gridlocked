import { eq } from "drizzle-orm";
import { settings } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  settingDefaults,
  settingSchemas,
  type SettingKey,
  type SettingValue,
} from "./defaults";

export type { SettingKey, SettingValue } from "./defaults";

/**
 * The stored value for `key`, validated by its Zod schema, or the typed
 * default when there is no row. A stored value that fails validation throws:
 * a bad admin edit must be noticed, not silently replaced by the default.
 */
export async function getSetting<K extends SettingKey>(
  db: Db,
  key: K,
): Promise<SettingValue<K>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  if (!row) return settingDefaults[key];

  const parsed = settingSchemas[key].safeParse(row.value);
  if (!parsed.success) {
    throw new Error(`Invalid stored setting "${key}": ${parsed.error.message}`);
  }
  return parsed.data as SettingValue<K>;
}

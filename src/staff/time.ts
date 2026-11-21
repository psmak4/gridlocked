import { dayLabel, zoneOrUtc } from "@/lib/settings-words";

/** "21 Nov, 08:05" in the staff member's zone: when a staff screen's row happened. */
export function staffTime(date: Date, timeZone: string, now: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zoneOrUtc(timeZone),
  }).format(date);
  return `${dayLabel(date, timeZone, now)}, ${time}`;
}

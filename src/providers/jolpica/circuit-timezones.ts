/**
 * IANA time zones by Jolpica circuit id. Jolpica gives no zone (DM 1.2), so
 * the adapter carries the zones for the circuits on the calendar. A circuit
 * missing here comes through with a null zone and goes to an admin.
 */
export const circuitTimezones: Readonly<Record<string, string>> = {
  albert_park: "Australia/Melbourne",
  americas: "America/Chicago",
  bahrain: "Asia/Bahrain",
  baku: "Asia/Baku",
  catalunya: "Europe/Madrid",
  hungaroring: "Europe/Budapest",
  imola: "Europe/Rome",
  interlagos: "America/Sao_Paulo",
  jeddah: "Asia/Riyadh",
  losail: "Asia/Qatar",
  madring: "Europe/Madrid",
  marina_bay: "Asia/Singapore",
  miami: "America/New_York",
  monaco: "Europe/Monaco",
  monza: "Europe/Rome",
  red_bull_ring: "Europe/Vienna",
  rodriguez: "America/Mexico_City",
  sepang: "Asia/Kuala_Lumpur",
  shanghai: "Asia/Shanghai",
  silverstone: "Europe/London",
  spa: "Europe/Brussels",
  suzuka: "Asia/Tokyo",
  vegas: "America/Los_Angeles",
  villeneuve: "America/Toronto",
  yas_marina: "Asia/Dubai",
  zandvoort: "Europe/Amsterdam",
};

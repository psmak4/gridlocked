import { describe, expect, it } from "vitest";
import { subscribeInput } from "./inputs";

const keys = { p256dh: "key", auth: "auth" };
const ok = (endpoint: string) =>
  subscribeInput.safeParse({ endpoint, keys }).success;

describe("subscribeInput", () => {
  it("takes the browsers' push services", () => {
    expect(ok("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(ok("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(
      true,
    );
    expect(ok("https://web.push.apple.com/abc")).toBe(true);
    expect(ok("https://wns2-db5p.notify.windows.com/w/?token=abc")).toBe(true);
  });

  it("refuses any other host, so the server never posts where a user says", () => {
    expect(ok("https://attacker.example/hook")).toBe(false);
    expect(ok("https://fcm.googleapis.com.attacker.example/x")).toBe(false);
    expect(ok("https://localhost/x")).toBe(false);
    expect(ok("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
  });
});

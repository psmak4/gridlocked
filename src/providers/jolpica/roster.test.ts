import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";
import { parseJolpicaConstructors, parseJolpicaDrivers } from "./roster";

describe("parseJolpicaDrivers", () => {
  const body = () => readFixture("jolpica/2026/drivers.json");

  it("parses every driver in the response", () => {
    const drivers = parseJolpicaDrivers(body());
    const total = Number(
      (body() as { MRData: { total: string } }).MRData.total,
    );
    expect(drivers).toHaveLength(total);
    expect(new Set(drivers.map((d) => d.key)).size).toBe(total);
  });

  it("maps a full driver record to our shape", () => {
    const albon = parseJolpicaDrivers(body()).find((d) => d.key === "albon");
    expect(albon).toEqual({
      key: "albon",
      givenName: "Alexander",
      familyName: "Albon",
      code: "ALB",
      permanentNumber: 23,
      nationality: "Thai",
      dateOfBirth: "1996-03-23",
    });
  });

  it("accepts a reserve driver with no code, number, birth date or nationality", () => {
    const aron = parseJolpicaDrivers(body()).find((d) => d.key === "paul_aron");
    expect(aron).toEqual({
      key: "paul_aron",
      givenName: "Paul",
      familyName: "Aron",
      code: null,
      permanentNumber: null,
      nationality: "",
      dateOfBirth: null,
    });
  });

  it("rejects a response that is not a driver list", () => {
    expect(() => parseJolpicaDrivers({})).toThrow();
    expect(() =>
      parseJolpicaDrivers({
        MRData: { DriverTable: { Drivers: [{ driverId: "x" }] } },
      }),
    ).toThrow();
  });
});

describe("parseJolpicaConstructors", () => {
  const body = () => readFixture("jolpica/2026/constructors.json");

  it("parses the constructors and maps them to our team codes", () => {
    const list = parseJolpicaConstructors(body());
    expect(list).toHaveLength(11);
    expect(list.find((c) => c.key === "red_bull")).toEqual({
      key: "red_bull",
      name: "Red Bull",
      nationality: "Austrian",
      teamCode: "RBR",
    });
    expect(list.filter((c) => c.teamCode === null)).toEqual([]);
    expect(new Set(list.map((c) => c.teamCode)).size).toBe(11);
  });

  it("gives an unknown constructor a null team code", () => {
    const raw = structuredClone(body()) as {
      MRData: {
        ConstructorTable: { Constructors: Array<{ constructorId: string }> };
      };
    };
    raw.MRData.ConstructorTable.Constructors[0]!.constructorId = "newcomer";
    const list = parseJolpicaConstructors(raw);
    expect(list[0]).toMatchObject({ key: "newcomer", teamCode: null });
  });

  it("rejects a response that is not a constructor list", () => {
    expect(() => parseJolpicaConstructors(null)).toThrow();
  });
});

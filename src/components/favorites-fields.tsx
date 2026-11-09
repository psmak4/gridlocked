import { selectClass } from "@/components/account-layout";
import type { FavoriteChoices } from "@/server/account-actions";
import { cn } from "@/lib/utils";

export type FavoritesValue = { team: string; driver: string; country: string };

/**
 * The favorites form's fields, shared by onboarding Step 1 and settings: team
 * tiles and a driver list from the running game (left out when none runs),
 * and every country. `""` means none.
 */
export function FavoritesFields({
  value,
  onChange,
  choices,
  countries,
}: {
  value: FavoritesValue;
  onChange: (next: FavoritesValue) => void;
  choices: FavoriteChoices;
  countries: { code: string; name: string }[];
}) {
  const { constructors, drivers } = choices;
  return (
    <>
      {constructors.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-space-2 border-0 p-0">
          <legend className="pb-space-2 text-[14px] font-bold">
            Favorite team
          </legend>
          <div className="grid grid-cols-3 gap-space-2">
            {constructors.map((c) => {
              const picked = value.team === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={picked}
                  onClick={() =>
                    onChange({ ...value, team: picked ? "" : c.id })
                  }
                  className={cn(
                    "flex min-h-[64px] cursor-pointer flex-col items-center justify-center gap-[6px] rounded-radius-m border-2 bg-surface-raised px-[2px] py-space-2 font-sans text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                    picked ? "border-ink" : "border-transparent",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="h-[6px] w-[28px] rounded-radius-pill"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="text-center text-[12px] leading-[14px] font-semibold">
                    {c.name}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {drivers.length > 0 ? (
        <div className="flex flex-col gap-[6px]">
          <label htmlFor="fav-driver" className="text-[14px] font-bold">
            Favorite driver
          </label>
          <select
            id="fav-driver"
            className={selectClass}
            value={value.driver}
            onChange={(e) => onChange({ ...value, driver: e.target.value })}
          >
            <option value="">Choose later</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-col gap-[6px]">
        <label htmlFor="fav-country" className="text-[14px] font-bold">
          Your country (optional)
        </label>
        <select
          id="fav-country"
          className={selectClass}
          value={value.country}
          onChange={(e) => onChange({ ...value, country: e.target.value })}
        >
          <option value="">Leave blank</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-[14px] text-ink-muted">
          Only used for a league of fans from your country.
        </span>
      </div>
    </>
  );
}

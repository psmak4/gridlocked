/**
 * Better Auth's own transaction, made visible to our hooks (M9 Task 2).
 *
 * Better Auth opens a transaction around a sign-up or a password reset and
 * runs our database hooks inside it, but gives them only its adapter, not the
 * Drizzle transaction. The database it is handed here is ours with one
 * method changed: `transaction` notes the transaction it opens, for as long
 * as the work inside it runs. A hook that writes through `current()` then
 * commits or rolls back with Better Auth's own rows; the rest of our code,
 * holding the plain database, is unaffected.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "@/db/types";

export type AuthTransactions = {
  /** The database to hand Better Auth's adapter. */
  db: Db;
  /** Better Auth's open transaction, inside it; undefined anywhere else. */
  current: () => Db | undefined;
};

export function captureTransactions(db: Db): AuthTransactions {
  const open = new AsyncLocalStorage<Db>();
  const transaction: Db["transaction"] = (work, config) =>
    db.transaction(
      (tx) => open.run(tx as unknown as Db, () => work(tx)),
      config,
    );
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") return transaction;
      const value: unknown = Reflect.get(target, property, target);
      // Methods run on the real database; the constructor stays as it is,
      // since Drizzle's `is()` reads its static fields.
      return typeof value === "function" && property !== "constructor"
        ? value.bind(target)
        : value;
    },
  });
  return { db: wrapped, current: () => open.getStore() };
}

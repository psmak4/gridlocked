import { createContext, useContext } from "react";
import type { AccountSummary } from "@/server/account";

/**
 * The signed-in person's summary, from the root route's gate, for the parts
 * of the frame that need it (the bell). Null when signed out, and outside a
 * page (a component test).
 */
export const AccountContext = createContext<AccountSummary | null>(null);

export const useAccount = () => useContext(AccountContext);

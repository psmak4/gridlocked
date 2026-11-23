/**
 * The commonest passwords, refused at sign-up, password change and reset
 * (ASVS 5.0 6.2.4; M9 Task 9). The list is the UK NCSC's 100,000 most-used
 * passwords from SecLists, cut to the ones at least 10 characters long (no
 * shorter password is allowed anyway), lower-cased: 9,126 of them, in
 * common-passwords.txt (licence beside it). Checked here, with no outside call.
 */
import list from "./common-passwords.txt?raw";

export { PASSWORD_TOO_COMMON } from "@/lib/password-refusals";

let common: ReadonlySet<string> | null = null;

/** True when `password`, in any case, is on the list. */
export function isCommonPassword(password: string): boolean {
  common ??= new Set(list.split("\n").filter(Boolean));
  return common.has(password.toLowerCase());
}

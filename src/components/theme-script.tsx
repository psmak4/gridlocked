import { ScriptOnce } from "@tanstack/react-router";

export const THEME_STORAGE_KEY = "gridlocked-theme";

// Runs before first paint so <html> carries the chosen theme before React
// hydrates. With no stored choice it leaves data-theme unset and the CSS
// prefers-color-scheme rule decides.
const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

/**
 * Written once into the server's HTML, with the page's CSP nonce, and removed
 * as it runs, so the browser's render has nothing to match it against.
 */
export function ThemeScript() {
  return <ScriptOnce>{script}</ScriptOnce>;
}

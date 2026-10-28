export const THEME_STORAGE_KEY = "gridlocked-theme";

// Runs before first paint so <html> carries the chosen theme before React
// hydrates. With no stored choice it leaves data-theme unset and the CSS
// prefers-color-scheme rule decides.
const script = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

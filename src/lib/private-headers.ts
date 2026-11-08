/** For a route that is for one signed-in person: no shared cache keeps it (HLD §11.4). */
export const privateHeaders = () => ({ "Cache-Control": "private, no-store" });

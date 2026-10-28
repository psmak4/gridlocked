// Postgres over Neon's HTTP SQL endpoint, the same call @neondatabase/serverless
// makes, without the driver (keeps the bundle tiny). Each call is one
// statement in its own transaction.
export type Sql = <T = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<T[]>;

export function makeSql(connectionString: string): Sql {
  const host = new URL(connectionString).hostname.replace(/^[^.]+\./, "api.");
  const endpoint = `https://${host}/sql`;
  return async (query, params = []) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Neon-Connection-String": connectionString, "content-type": "application/json" },
      body: JSON.stringify({ query, params }),
    });
    if (!res.ok) throw new Error(`sql ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { rows: never[] };
    return json.rows;
  };
}

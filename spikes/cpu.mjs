// Spike (Task 5): CPU per request against a local server started with
// SPIKE_CPU=1. Requests run one at a time; each is bracketed by reads of the
// process's cumulative CPU, minus the median cost of a bare read.
const base = process.argv[2] ?? "http://localhost:3100";
const cpu = async () =>
  (await (await fetch(`${base}/api/spike-cpu`)).json()).us;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (us) => (us / 1000).toFixed(2);

async function measure(label, run, n, warm) {
  for (let i = 0; i < warm; i++) await run(i);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const before = await cpu();
    await run(warm + i);
    const after = await cpu();
    samples.push(after - before - overhead);
  }
  console.log(
    `${label}: n=${n} p50=${ms(pct(samples, 50))} ms p95=${ms(pct(samples, 95))} ms max=${ms(Math.max(...samples))} ms`,
  );
}

let overhead = 0;
const bare = [];
for (let i = 0; i < 30; i++) {
  const a = await cpu();
  const b = await cpu();
  bare.push(b - a);
}
overhead = pct(bare, 50);
console.log(`bare read: p50=${ms(overhead)} ms (subtracted)`);

const get = (path) => async () => {
  const res = await fetch(base + path);
  await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}`);
};
const run = crypto.randomUUID().slice(0, 8);
const auth = (kind) => async (i) => {
  const email = `cpu-${run}-${i}@example.test`;
  // Sign-in i reuses the account sign-up i made (same run, same index).
  const res = await fetch(`${base}/api/auth/${kind}/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password: "spike-password-1", name: email }),
  });
  await res.text();
  if (!res.ok) throw new Error(`${kind} ${res.status}`);
};

await measure("GET / (no db)", get("/"), 50, 10);
await measure("GET /results/18 (SSR + PGlite)", get("/results/18"), 50, 10);
await measure(
  "GET /api/threads/1/latest (JSON + PGlite)",
  get("/api/threads/1/latest?w=1"),
  50,
  10,
);
await measure("POST sign-up (scrypt)", auth("sign-up"), 20, 2);
await measure("POST sign-in (scrypt)", auth("sign-in"), 20, 2);

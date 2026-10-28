// A minimal S3 client for Neon Object Storage: SigV4 signing with WebCrypto,
// path-style URLs. Small on purpose, so the function bundle stays tiny.
const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export type SignInput = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
};

/** Returns the request's headers plus the SigV4 ones (all names lowercase). */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const payloadHash = await sha256(input.body);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": input.amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");
  const canonicalRequest = [input.method, input.url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, await sha256(canonicalRequest)].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), day);
  for (const part of [input.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}

export type Bucket = { get(key: string): Promise<string | null>; put(key: string, body: string): Promise<void> };

export function makeBucket(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  now: () => Date;
}): Bucket {
  async function send(method: "GET" | "PUT", key: string, body = "") {
    const url = new URL(`${opts.endpoint.replace(/\/$/, "")}/${opts.bucket}/${key}`);
    const amzDate = opts.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers = await signRequest({ method, url, headers: method === "PUT" ? { "content-type": "application/json" } : {}, body, region: opts.region, accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, amzDate });
    delete headers.host;
    return fetch(url, { method, headers, body: method === "PUT" ? body : undefined });
  }
  return {
    async get(key) {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 GET ${key}: ${res.status} ${await res.text()}`);
      return res.text();
    },
    async put(key, body) {
      const res = await send("PUT", key, body);
      if (!res.ok) throw new Error(`s3 PUT ${key}: ${res.status} ${await res.text()}`);
    },
  };
}

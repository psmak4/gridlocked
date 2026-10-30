/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Spike: "1" in local builds, which then use the seeded PGlite (ledger R1). */
  readonly VITE_SPIKE_LOCAL?: string;
}

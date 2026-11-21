import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const container = defineContainer({
  name: "codex",
  schedulingPolicy: "durable-object"
});

export default defineConfig({
  worker: {
    name: "cf-codex",
    entrypoint,
    compatibilityDate: "2026-11-06",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      CodexAgent: exports.durableObject({ storage: "sqlite", container }),
      ContainerEgress: exports.worker()
    },
    env: {
      CF_CODEX_API_TOKEN: bindings.secret()
    }
  },
  containers: [container]
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: [{ find: /^@paperclipai\/paperclip-runner$/, replacement: fileURLToPath(new URL("../../paperclip-runner/src/index.ts", import.meta.url)) }] },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});

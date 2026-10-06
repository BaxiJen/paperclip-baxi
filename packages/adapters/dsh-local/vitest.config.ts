import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "@baxijen/paperclip-adapter-dsh", environment: "node", include: ["test/**/*.test.ts"] } });

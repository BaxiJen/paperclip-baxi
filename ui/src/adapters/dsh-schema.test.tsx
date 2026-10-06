// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { schema } from "../../../packages/adapters/dsh-local/src/definition";
import { SchemaConfigFields, invalidateConfigSchemaCache, buildSchemaAdapterConfig } from "./schema-config-fields";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { TooltipProvider } from "../components/ui/tooltip";
import { setupProviderKeys } from "../lib/agent-setup-fields";

it("mostra API custom condicionalmente, sugestões por provedor e texto livre", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => schema })));
  invalidateConfigSchemaCache("dsh_local");
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const set = vi.fn();
  const view = (provider: string) => <TooltipProvider><SchemaConfigFields mode="create" isCreate adapterType="dsh_local"
    values={{ ...defaultCreateValues, adapterSchemaValues: { provider } }} set={set} config={{}} eff={(_g, _f, original) => original} mark={() => {}} models={[]} /></TooltipProvider>;
  try {
    await act(async () => root.render(view("deepseek")));
    expect(container.textContent).toContain("1. Provedor"); expect(container.textContent).not.toContain("URL base");
    await act(async () => root.render(view("custom")));
    expect(container.textContent).toContain("URL base"); expect(container.textContent).toContain("ID permanente do provedor");
    expect(container.textContent).toContain("OpenAI Chat Completions");
    const modelInput = container.querySelector('input[placeholder^="Use Testar ambiente"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(modelInput, "custom-model-id");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => modelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(set).toHaveBeenLastCalledWith({ adapterSchemaValues: { provider: "custom", model: "custom-model-id" } });
    expect(buildSchemaAdapterConfig({ ...defaultCreateValues, adapterSchemaValues: { provider: "custom", model: "custom-model-id" } })).toEqual({ provider: "custom", model: "custom-model-id" });
    expect(setupProviderKeys("dsh_local")).toEqual({ deepseek: "DEEPSEEK_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", moonshotai: "MOONSHOT_API_KEY", zai: "ZAI_API_KEY", custom: "DSH_CUSTOM_API_KEY" });
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

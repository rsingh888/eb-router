import { describe, it, expect } from "vitest";
import { detectFormatByEndpoint, FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Cursor Agent chat/completions compatibility", () => {
  it("detectFormatByEndpoint treats input[] on chat/completions as openai-responses", () => {
    const body = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    expect(detectFormatByEndpoint("/v1/chat/completions", body)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(detectFormatByEndpoint("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] })).toBeNull();
  });

  it("translates Responses-shaped body to chat messages for upstream OpenAI providers", () => {
    const body = {
      model: "groq/openai/gpt-oss-120b",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }],
    };
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-oss-120b", body);
    expect(translated.input).toBeUndefined();
    expect(translated.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(translated.tools[0].function.name).toBe("read_file");
  });
});

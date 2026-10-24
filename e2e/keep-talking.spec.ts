import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fakeMicrophone } from "./fake-microphone.ts";
import { addWorkspace, createProfile, openSettings, signIn, useOwnVoiceServer, voiceSection } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";
import { toneWav } from "./wav.ts";

test.use(fakeMicrophone);

const SAID = ["SAY First answer.", "SAY Second answer.", "SAY Third answer."];

let heard = 0;

/** Speech recognition hears the next of what was said each time, the voice model sums a reply up in one sentence, and the reply voice plays a tone. */
const voiceServer = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    if (request.url!.endsWith("/audio/transcriptions")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ text: SAID[heard++] ?? "SAY Too many.", language: "en" }));
    }
    if (request.url!.endsWith("/chat/completions")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The agent answered." }, finish_reason: "stop" }] }));
    }
    response.setHeader("content-type", "audio/wav");
    response.end(toneWav(1));
  });
});

const host = new TestHost({ fakePrograms: true });

test.beforeAll(async () => {
  await new Promise<void>((resolve) => voiceServer.listen(0, "127.0.0.1", resolve));
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: join(host.root, "prompts") });
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  voiceServer.close();
});

const voiceAddress = () => `http://127.0.0.1:${(voiceServer.address() as AddressInfo).port}/v1`;

test("with Keep talking, the microphone opens again once a dictated message's reply has been read, and what is said next is sent", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "voice", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "voice · opencode" });
  await page.getByRole("button", { name: "+ New conversation" }).click();

  const settings = await openSettings(page, "Voice");
  await useOwnVoiceServer(voiceSection(settings, "When you speak"), "Speech recognition", { url: voiceAddress(), model: "whisper-turbo" });
  await useOwnVoiceServer(voiceSection(settings, "Translating and summing up"), "Voice model", { url: voiceAddress(), model: "gemma" });
  const replies = voiceSection(settings, "When the agent replies");
  await expect(replies.getByLabel("Keep talking"), "only spoken replies can keep a conversation going").toHaveCount(0);
  await useOwnVoiceServer(replies, "Read aloud", { url: voiceAddress(), model: "kokoro", voice: "af_heart" });
  await replies.getByLabel("Keep talking").check();
  await expect(replies.getByRole("status")).toHaveText("Saved.");
  await settings.getByRole("button", { name: "Close" }).click();

  const asked = page.locator(".timeline:visible .message.user");
  const answers = page.locator(".timeline:visible .message.agent");
  const composer = page.locator(".composer:visible");
  const dictate = composer.getByRole("button", { name: "Dictate" });

  await test.step("the first dictated message is checked and sent by hand, as Send right away is off", async () => {
    await dictate.click();
    await expect(composer.locator("textarea")).toHaveValue(SAID[0]!, { timeout: 30_000 });
    await composer.locator("textarea").press("Enter");
    await expect(answers.last()).toHaveText("First answer.", { timeout: 30_000 });
  });

  await test.step("once its reply has been read, the microphone listens again and sends what it hears, turn after turn", async () => {
    await expect(asked).toHaveText(SAID.slice(0, 2), { timeout: 30_000 });
    await expect(answers.last()).toHaveText("Second answer.", { timeout: 30_000 });
    await expect(dictate, "and listens once more after the second reply").toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  });

  await test.step("Esc ends the conversation: nothing more is sent", async () => {
    await page.keyboard.press("Escape");
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(6_000);
    await expect(asked).toHaveCount(2);
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
  });
});

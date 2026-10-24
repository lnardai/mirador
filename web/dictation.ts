import type { VoiceSettings } from "../shared/voice.ts";
import type { EngineServer, EngineServerState } from "../shared/voice-engine.ts";

/** A press let go of sooner than this is a tap: listening goes on until a pause or the next press. */
export const HOLD_MS = 400;

export type Press = { kind: "up" } | { kind: "down"; at: number } | { kind: "tapped" };
type PressAction = "start" | "finish" | null;

export function pressed(press: Press, at: number): { press: Press; action: PressAction } {
  if (press.kind === "up") return { press: { kind: "down", at }, action: "start" };
  if (press.kind === "tapped") return { press: { kind: "up" }, action: "finish" };
  return { press, action: null };
}

export function released(press: Press, at: number): { press: Press; action: PressAction } {
  if (press.kind !== "down") return { press, action: null };
  return at - press.at < HOLD_MS ? { press: { kind: "tapped" }, action: null } : { press: { kind: "up" }, action: "finish" };
}

export type DictationPhase = "idle" | "starting" | "listening" | "transcribing";

/** Said on its own while keeping a spoken conversation going, these go to Mirador instead of the agent. */
export type VoiceCommand = "stop" | "repeat";

const voiceCommands: Record<VoiceCommand, string[]> = {
  stop: ["stop", "stop listening", "stop talking", "be quiet", "that's all", "that is all", "enough", "bye", "bye bye", "goodbye"],
  repeat: ["repeat", "repeat that", "repeat it", "say that again", "say it again", "again", "once more"],
};

const politeWords = /^(please|ok|okay)\s+|\s+please$/g;

const asCommand = (words: string) =>
  words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(politeWords, "")
    .trim();

/** What speech recognition, Whisper most of all, is known to write for silence, noise or music, as if a video were ending. */
const madeUpPhrases = new Set([
  "thank you",
  "thanks",
  "thank you very much",
  "thank you for watching",
  "thanks for watching",
  "thank you so much for watching",
  "please subscribe",
  "subscribe",
  "you",
  "subtitles by the amara org community",
]);

/** Nothing but words that recognition makes up from silence, or no words at all: not worth sending. */
export function madeUpFromSilence(text: string) {
  const sentences = text.split(/[.!?…\n]+/).map(asCommand).filter((sentence) => sentence !== "");
  return sentences.every((sentence) => madeUpPhrases.has(sentence));
}

/** In English, after translation, so one set of phrases serves every language; only the whole of it counts: "stop the build" goes to the agent. */
export function voiceCommand(text: string): VoiceCommand | null {
  const said = asCommand(text);
  for (const [command, phrases] of Object.entries(voiceCommands) as [VoiceCommand, string[]][]) {
    if (phrases.includes(said)) return command;
  }
  return null;
}

export function dictationStatus(phase: DictationPhase, settings: VoiceSettings, servers: Record<EngineServer, EngineServerState>) {
  if (phase === "idle") return null;
  if (phase === "starting") return "Starting the microphone…";
  if (phase === "listening") return "Listening… It stops when you pause or let go. Esc cancels.";
  if (settings.recognition.kind === "this-mac" && servers.speech !== "ready") return "Loading speech recognition on this Mac…";
  if (settings.voiceModel.kind === "this-mac" && servers.voiceModel === "loading") return "Loading the voice model on this Mac…";
  return "Turning speech into text…";
}

/** What was said goes in as words of their own, with a space between them and the text on either side. */
export function spacedAtCaret(text: string, start: number, end: number, words: string) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const spaceBefore = before !== "" && !/\s$/.test(before) ? " " : "";
  const spaceAfter = after !== "" && !/^\s/.test(after) ? " " : "";
  return spaceBefore + words.trim() + spaceAfter;
}

export const NO_MICROPHONE_API = "NoMicrophoneApi";

export interface MicrophonePlace {
  desktopApp: boolean;
  secure: boolean;
  system: "mac" | "windows" | "other";
}

const systemMicrophoneSetting = { mac: " and in System Settings → Privacy & Security → Microphone", windows: " and in Windows Settings → Privacy & security → Microphone, which desktop apps need too", other: "" };

/** What to tell the user when the microphone doesn't start, by the error's name, or NO_MICROPHONE_API when the page offers none. */
export function microphoneProblem(errorName: string, place: MicrophonePlace, detail = "") {
  if (errorName === NO_MICROPHONE_API && !place.secure) return "Pages may use the microphone only when opened over https or at localhost. Open Mirador at one of those to dictate.";
  if (errorName === NO_MICROPHONE_API) return place.desktopApp ? "This build of the desktop app can't use the microphone. Update or rebuild it, or dictate in a browser." : "This browser doesn't let pages use the microphone.";
  if (errorName === "NotAllowedError" && place.desktopApp) {
    return `Mirador may not use the microphone. Allow it when the desktop app asks${systemMicrophoneSetting[place.system]}. Blocking it in the app holds until the app quits.`;
  }
  if (errorName === "NotAllowedError") return "Mirador may not use the microphone. The browser's settings for this site can allow it.";
  if (errorName === "NotFoundError") return "There is no microphone to listen with.";
  return `The microphone didn't start: ${detail}`;
}

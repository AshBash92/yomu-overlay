// Talks to the Claude API. Runs in the background service worker only.

const API_BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2026-10-21";

// Models that accept the server-side refusal fallback. If Claude declines a
// page (e.g. a false positive on violent manga), the API retries it on
// another model inside the same call instead of failing.
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

const REQUEST_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const SYSTEM_PROMPT = `You translate Japanese manga for an English-speaking reader who is learning Japanese.

You receive a screenshot of the visible part of a web page. Find every region of Japanese text that is part of the manga artwork: speech bubbles, thought bubbles, narration boxes, sound effects, and signs. Ignore website UI, menus, ads, page numbers, and comments.

For each region:
- box: a box around the region's text area, as fractions (0 to 1) of the full screenshot's width and height. x and y are the top-left corner. Cover the text the reader would want hidden by the translation, staying inside the bubble.
- kind: what the region is.
- japanese: the text exactly as written, with line breaks removed. Vertical text reads top to bottom, columns right to left.
- reading: the whole line in hiragana.
- english: a natural, conversational translation that keeps the character's tone. Keep it short enough to fit in the bubble.
- words: the line split into words in order, particles included. For each word give its dictionary reading in hiragana, a short English meaning, the part of speech, and one entry per kanji with that kanji's core meaning (empty list if the word has no kanji).

List regions in Japanese reading order: panels right to left, top to bottom. Skip text cut off so badly at the screenshot edge that it can't be read. If there is no Japanese manga text, return an empty list.`;

const KANJI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["character", "meaning"],
  properties: {
    character: { type: "string" },
    meaning: { type: "string" },
  },
};

const WORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["word", "reading", "meaning", "partOfSpeech", "kanji"],
  properties: {
    word: { type: "string" },
    reading: { type: "string" },
    meaning: { type: "string" },
    partOfSpeech: { type: "string" },
    kanji: { type: "array", items: KANJI_SCHEMA },
  },
};

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["regions"],
  properties: {
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["box", "kind", "japanese", "reading", "english", "words"],
        properties: {
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "width", "height"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          kind: {
            type: "string",
            enum: ["speech", "thought", "narration", "sfx", "sign"],
          },
          japanese: { type: "string" },
          reading: { type: "string" },
          english: { type: "string" },
          words: { type: "array", items: WORD_SCHEMA },
        },
      },
    },
  },
};

function headers(apiKey, betas = []) {
  const h = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // Required for calls made from a browser/extension rather than a server.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (betas.length) h["anthropic-beta"] = betas.join(",");
  return h;
}

async function request(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("timeout", "Claude took too long to answer. Try again.");
    }
    throw new ApiError("network", "Couldn't reach the Claude API. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

async function toApiError(res) {
  let detail = "";
  try {
    detail = (await res.json())?.error?.message ?? "";
  } catch {}
  switch (res.status) {
    case 401:
      return new ApiError("auth", "Your API key was rejected. Check it on the options page.", 401);
    case 403:
      return new ApiError("permission", "Your API key isn't allowed to use this model.", 403);
    case 404:
      return new ApiError("not_found", `Model not found. Pick another model on the options page. ${detail}`, 404);
    case 413:
      return new ApiError("too_large", "The screenshot was too large to send.", 413);
    case 429: {
      const wait = res.headers.get("retry-after");
      const when = wait ? ` Try again in ${wait}s.` : " Wait a moment and try again.";
      return new ApiError("rate_limit", `Rate limit reached.${when}`, 429);
    }
    case 529:
      return new ApiError("overloaded", "Claude is overloaded right now. Try again shortly.", 529);
    default:
      if (res.status >= 500) {
        return new ApiError("server", `Claude API server error (${res.status}). Try again shortly.`, res.status);
      }
      return new ApiError("bad_request", `Request failed (${res.status}): ${detail}`, res.status);
  }
}

/**
 * Sends one screenshot to Claude and returns { regions: [...] }.
 * image: { mediaType, data } where data is base64 without the data: prefix.
 */
export async function translateImage({ apiKey, model, effort, image }) {
  const useFallback = FALLBACK_MODELS.has(model);
  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          },
          { type: "text", text: "Translate the manga text in this screenshot." },
        ],
      },
    ],
    output_config: {
      effort,
      format: { type: "json_schema", schema: RESULT_SCHEMA },
    },
  };
  if (useFallback) body.fallbacks = "default";

  const data = await request("/messages", {
    method: "POST",
    headers: headers(apiKey, useFallback ? ["server-side-fallback-2026-07-01"] : []),
    body: JSON.stringify(body),
  });

  if (data.stop_reason === "refusal") {
    throw new ApiError("refusal", "Claude declined to translate this page.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new ApiError("truncated", "This view has too much text to translate at once. Zoom in so less is on screen, then try again.");
  }
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new ApiError("empty", "Claude returned no translation.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("parse", "Claude's answer wasn't valid JSON. Try again.");
  }
}

/** Checks a key without spending tokens. */
export async function testApiKey(apiKey) {
  await request("/models?limit=1", { method: "GET", headers: headers(apiKey) });
}

// Talks to the Claude API. Runs in the background service worker
// (and the options page, for the key test).

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

// Give up if the stream goes quiet for this long.
const IDLE_TIMEOUT_MS = 90_000;

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
- english: a natural, conversational translation that keeps the character's tone. Keep it short enough to fit in the bubble.

List regions in Japanese reading order: panels right to left, top to bottom. Skip text cut off so badly at the screenshot edge that it can't be read. If there is no Japanese manga text, return an empty list.`;

const SKIP_SFX = `

The reader can already read sound effects, so skip them: leave out onomatopoeia and sound effects drawn into the artwork (ドン, ゴゴゴ, ざわざわ and the like), and never use the "sfx" kind.`;

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
        required: ["box", "kind", "japanese", "english"],
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
          english: { type: "string" },
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

// fetch() with a timeout that resets whenever data arrives.
function idleTimer(controller) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  reset();
  return { reset, stop: () => clearTimeout(timer) };
}

async function send(path, init, controller) {
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    throw networkError(err);
  }
}

function networkError(err) {
  if (err instanceof ApiError) return err;
  if (err.name === "AbortError") {
    return new ApiError("timeout", "Claude stopped responding. Try again.");
  }
  return new ApiError("network", "Couldn't reach the Claude API. Check your internet connection.");
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

// Errors that arrive inside a stream after a 200 response.
function streamError(error) {
  const type = error?.type ?? "";
  if (type === "overloaded_error") {
    return new ApiError("overloaded", "Claude is overloaded right now. Try again shortly.");
  }
  if (type === "rate_limit_error") {
    return new ApiError("rate_limit", "Rate limit reached. Wait a moment and try again.");
  }
  return new ApiError("server", `Claude API error: ${error?.message ?? type ?? "unknown"}`);
}

// Pulls each finished region object out of the partial JSON text
// {"regions":[{...},{...}, ...  as it streams in.
class RegionExtractor {
  constructor(onRegion) {
    this.onRegion = onRegion;
    this.text = "";
    this.pos = 0;
    this.inArray = false;
    this.done = false;
    this.depth = 0;
    this.start = -1;
    this.inString = false;
    this.escaped = false;
  }

  push(chunk) {
    this.text += chunk;
    for (; this.pos < this.text.length && !this.done; this.pos++) {
      const c = this.text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (!this.inArray) {
        if (c === "[") this.inArray = true;
      } else if (c === "{" || c === "[") {
        if (this.depth === 0) this.start = this.pos;
        this.depth++;
      } else if (c === "}" || c === "]") {
        if (this.depth === 0) {
          this.done = true; // closing bracket of the regions array
        } else if (--this.depth === 0) {
          try {
            this.onRegion(JSON.parse(this.text.slice(this.start, this.pos + 1)));
          } catch (err) {
            console.warn("Yomu: skipped a region that didn't parse", err);
          }
        }
      }
    }
  }
}

// Yields parsed server-sent events from a streaming response.
async function* readEvents(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    onData();
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}

/**
 * Streams one screenshot through Claude. Calls onRegion for each text
 * region as soon as it's complete. Resolves with { regions, stats }.
 * image: { mediaType, data } where data is base64 without the data: prefix.
 */
export async function translateImage({ apiKey, model, effort, showSfx, image, onRegion }) {
  const useFallback = FALLBACK_MODELS.has(model);
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    system: showSfx ? SYSTEM_PROMPT : SYSTEM_PROMPT + SKIP_SFX,
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

  const started = performance.now();
  const stats = { model, inputTokens: 0, outputTokens: 0, firstByteMs: 0, firstRegionMs: 0, totalMs: 0 };
  const regions = [];
  const extractor = new RegionExtractor((region) => {
    if (!region?.box || typeof region.english !== "string") return;
    // Backstop in case Claude includes a sound effect anyway.
    if (!showSfx && region.kind === "sfx") return;
    if (!regions.length) stats.firstRegionMs = performance.now() - started;
    regions.push(region);
    onRegion?.(region);
  });

  const controller = new AbortController();
  const timer = idleTimer(controller);
  let stopReason = null;

  try {
    const res = await send(
      "/messages",
      {
        method: "POST",
        headers: headers(apiKey, useFallback ? ["server-side-fallback-2026-07-01"] : []),
        body: JSON.stringify(body),
      },
      controller
    );
    if (!res.ok) throw await toApiError(res);
    stats.firstByteMs = performance.now() - started;

    for await (const event of readEvents(res, timer.reset)) {
      switch (event.type) {
        case "message_start":
          stats.model = event.message?.model ?? model;
          stats.inputTokens = event.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (event.content_block?.type === "fallback") {
            console.info("Yomu: Claude handed this page to a fallback model", event.content_block);
          }
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta") extractor.push(event.delta.text);
          break;
        case "message_delta":
          stopReason = event.delta?.stop_reason ?? stopReason;
          stats.outputTokens = event.usage?.output_tokens ?? stats.outputTokens;
          break;
        case "error":
          throw streamError(event.error);
      }
    }
  } catch (err) {
    throw networkError(err);
  } finally {
    timer.stop();
  }

  stats.totalMs = performance.now() - started;

  if (stopReason === "refusal" && !regions.length) {
    throw new ApiError("refusal", "Claude declined to translate this page.");
  }
  if (stopReason === "max_tokens" && !regions.length) {
    throw new ApiError("truncated", "This view has too much text to translate at once. Zoom in so less is on screen, then try again.");
  }
  if (!extractor.inArray && !regions.length) {
    throw new ApiError("empty", "Claude returned no translation. Try again.");
  }
  return { regions, stopReason, stats };
}

/** Checks a key without spending tokens. */
export async function testApiKey(apiKey) {
  const controller = new AbortController();
  const timer = idleTimer(controller);
  try {
    const res = await send("/models?limit=1", { method: "GET", headers: headers(apiKey) }, controller);
    if (!res.ok) throw await toApiError(res);
  } finally {
    timer.stop();
  }
}

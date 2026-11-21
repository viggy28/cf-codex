import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "cf-codex",
  "config.json"
);

export function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const equals = value.indexOf("=");
    if (equals !== -1) {
      flags[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }

    const name = value.slice(2);
    if (name === "json") {
      flags[name] = true;
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = next;
    index += 1;
  }

  return { flags, positional };
}

async function loadStoredConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Could not read ${CONFIG_PATH}: ${error.message}`);
  }
}

async function saveStoredConfig(patch) {
  const current = await loadStoredConfig();
  const next = { ...current, ...patch };
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
  return next;
}

async function runtimeConfig() {
  const stored = await loadStoredConfig();
  return {
    ...stored,
    url: process.env.CF_CODEX_URL || stored.url,
    token: process.env.CF_CODEX_TOKEN || stored.token
  };
}

async function api(path, init = {}) {
  const config = await runtimeConfig();
  if (!config.url) {
    throw new Error("No service URL. Run: cf-codex configure --url <url> --token <token>");
  }
  if (!config.token) {
    throw new Error("No API token. Run: cf-codex configure --url <url> --token <token>");
  }

  const response = await fetch(`${config.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = JSON.parse(body).error || body;
    } catch {
      // Keep the response text.
    }
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }

  return response;
}

async function jsonApi(path, init) {
  return (await api(path, init)).json();
}

async function readPrompt(positional, explicitPrompt) {
  if (explicitPrompt) return explicitPrompt;
  if (positional.length) return positional.join(" ");
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += chunk;
    if (value.trim()) return value.trim();
  }
  throw new Error("A prompt is required as arguments, --prompt, or stdin");
}

async function resolveSession(value) {
  if (value) return value;
  const config = await loadStoredConfig();
  if (!config.lastSession) throw new Error("A session ID is required");
  return config.lastSession;
}

function print(value, asJson = false) {
  if (asJson || typeof value !== "object") console.log(asJson ? JSON.stringify(value) : value);
  else console.log(JSON.stringify(value, null, 2));
}

function messageText(message) {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text" && part.text?.trim())
    .map((part) => part.text.trim());
}

function latestAssistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    const text = messageText(messages[index]);
    if (text.length) return text.at(-1);
  }
  return undefined;
}

function formatStatus(session, status) {
  const messages = status.messages ?? [];
  const pending = status.pending ?? [];
  const messageCount = status.messageCount ?? messages.length;
  const latestActivity = status.lastActivity ?? messages.at(-1)?.createdAt;
  const latest = status.latestText ?? latestAssistantText(messages);
  const state = pending.some((operation) => operation.status === "running")
    ? "running"
    : pending.length
      ? "queued"
      : "idle";
  const lines = [
    `Session:   ${session}`,
    `Container: ${status.container?.running ? "running" : "stopped"}`,
    `State:     ${state}`,
    `Messages:  ${messageCount}`
  ];
  if (latestActivity) lines.push(`Updated:   ${new Date(latestActivity).toLocaleString()}`);
  for (const operation of pending) {
    lines.push(`Operation: ${operation.operationId} (${operation.status})`);
  }
  if (latest) {
    const oneLine = latest.replace(/\s+/g, " ").trim();
    lines.push(`Latest:    ${oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine}`);
  }
  return lines.join("\n");
}

function formatMessages(messages) {
  const visible = messages.filter((message) =>
    !messageText(message).includes("Prepare this Codex session for ChatGPT device authentication.")
  );
  if (!visible.length) return "No conversation messages yet.";

  return visible.map((message) => {
    const text = messageText(message);
    const omittedTools = (message.parts ?? []).filter((part) => part.type === "tool").length;
    const heading = `${message.role.toUpperCase()} · ${new Date(message.createdAt).toLocaleString()}`;
    const suffix = omittedTools ? `\n[${omittedTools} tool calls omitted]` : "";
    return `${heading}\n${text.join("\n\n") || "[no text]"}${suffix}`;
  }).join("\n\n---\n\n");
}

function renderEvent(eventName, data, state) {
  if (eventName === "snapshot") {
    const messages = data?.messages ?? [];
    for (const message of messages) {
      for (const [index, part] of (message.parts ?? []).entries()) {
        state.parts.set(`${message.id}:${index}`, part.type === "text" ? part.text : part.state);
      }
    }
    const busy = Boolean(data?.busy || data?.pending?.length);
    const lines = [`[connected] ${data?.session ?? "session"} · ${busy ? "running" : "idle"}`];
    const latest = latestAssistantText(messages);
    if (latest) lines.push(latest);
    return { lines, done: !busy };
  }

  if (data?.message?.parts) {
    const lines = [];
    for (const [index, part] of data.message.parts.entries()) {
      const key = `${data.message.id}:${index}`;
      const previous = state.parts.get(key);
      if (part.type === "text" && part.text && part.text !== previous) {
        lines.push(previous && part.text.startsWith(previous)
          ? part.text.slice(previous.length)
          : part.text);
        state.parts.set(key, part.text);
      } else if (part.type === "tool") {
        if (previous === undefined) lines.push(`[tool] ${part.toolName ?? "tool"}`);
        if (part.state === "error" && previous !== "error") {
          lines.push(`[tool failed] ${part.toolName ?? "tool"}`);
        }
        state.parts.set(key, part.state);
      }
    }
    return { lines, done: false };
  }

  if (eventName === "usage") {
    return {
      lines: [`[usage] input ${data?.inputTokens ?? 0} · output ${data?.outputTokens ?? 0} tokens`],
      done: false
    };
  }
  if (eventName === "log") {
    return { lines: [`[${data?.level ?? "log"}] ${data?.message ?? ""}`], done: false };
  }
  if (data?.status) return { lines: [`[${eventName}] ${data.status}`], done: false };
  return { lines: [], done: false };
}

async function loginSession(session) {
  const controller = new AbortController();
  let authenticated;
  let checking = false;
  const check = async () => {
    if (checking || authenticated?.authenticated) return;
    checking = true;
    try {
      const status = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}/auth`);
      if (status.authenticated) {
        authenticated = status;
        controller.abort();
      }
    } catch {
      // Login may still be creating the credential file.
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => void check(), 2_000);
  try {
    const response = await api(`/v1/sessions/${encodeURIComponent(session)}/login`, {
      method: "POST",
      signal: controller.signal
    });
    if (!response.body) throw new Error("The server returned no login stream");

    try {
      for await (const chunk of response.body) process.stderr.write(chunk);
    } catch (error) {
      if (!authenticated?.authenticated && error?.name !== "AbortError") throw error;
    }
  } finally {
    clearInterval(timer);
  }

  if (process.stderr.isTTY) process.stderr.write("\n");
  const status = authenticated ?? await jsonApi(
    `/v1/sessions/${encodeURIComponent(session)}/auth`
  );
  if (!status.authenticated) {
    throw new Error(`ChatGPT authentication failed: ${status.status || "not logged in"}`);
  }
  return status;
}

async function streamEvents(session, asJson) {
  const controller = new AbortController();
  const response = await api(`/v1/sessions/${encodeURIComponent(session)}/events`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal
  });
  if (!response.body) throw new Error("The server returned no event stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { parts: new Map() };
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = "message";
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n");
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // Keep non-JSON event data as text.
        }
        if (asJson) {
          print({ event: eventName, data }, true);
          continue;
        }
        const rendered = renderEvent(eventName, data, state);
        for (const line of rendered.lines) {
          if (line?.trim()) console.log(line.trim());
        }
        if (rendered.done) {
          await reader.cancel();
          return;
        }
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (command) {
    case "configure": {
      const patch = {};
      if (flags.url) patch.url = flags.url;
      if (flags.token) patch.token = flags.token;
      if (!Object.keys(patch).length) throw new Error("Provide --url and/or --token");
      await saveStoredConfig(patch);
      console.log(`Saved configuration to ${CONFIG_PATH}`);
      return;
    }

    case "start": {
      const prompt = await readPrompt(positional, flags.prompt);
      console.error("Preparing a remote Codex container...");
      const prepared = await jsonApi("/v1/sessions", { method: "POST" });
      const session = prepared.sessionId;
      await saveStoredConfig({ lastSession: session });

      console.error(`Session: ${session}`);
      console.error("Authenticate this session with your ChatGPT subscription:");
      const authentication = await loginSession(session);
      console.error(authentication.status || "ChatGPT authentication complete.");

      const receipt = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          text: prompt,
          repo: flags.repo,
          ref: flags.ref,
          operationId: flags["operation-id"]
        })
      });
      const result = { sessionId: session, ...receipt };
      await saveStoredConfig({
        lastSession: session,
        lastOperation: receipt.operationId
      });
      if (flags.json) print(result, true);
      else {
        console.log(`Session:   ${session}`);
        console.log(`Operation: ${receipt.operationId}`);
        console.log("Status:    submitted");
      }
      return;
    }

    case "login": {
      const session = await resolveSession(positional[0]);
      const result = await loginSession(session);
      print(result, Boolean(flags.json));
      return;
    }

    case "auth": {
      const session = await resolveSession(positional[0]);
      const result = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}/auth`);
      print(result, Boolean(flags.json));
      return;
    }

    case "prompt": {
      const explicitSession = /^cx_[a-f0-9]{32}$/.test(positional[0] ?? "")
        ? positional.shift()
        : undefined;
      const session = await resolveSession(explicitSession);
      const text = await readPrompt(positional, flags.prompt);
      const result = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text, operationId: flags["operation-id"] })
      });
      await saveStoredConfig({ lastSession: session, lastOperation: result.operationId });
      print(result, Boolean(flags.json));
      return;
    }

    case "status": {
      const session = await resolveSession(positional[0]);
      const result = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}`);
      print(flags.json ? result : formatStatus(session, result), Boolean(flags.json));
      return;
    }

    case "messages": {
      const session = await resolveSession(positional[0]);
      const result = await jsonApi(`/v1/sessions/${encodeURIComponent(session)}/messages`);
      print(flags.json ? result : formatMessages(result), Boolean(flags.json));
      return;
    }

    case "logs": {
      const session = await resolveSession(positional[0]);
      await streamEvents(session, Boolean(flags.json));
      return;
    }

    case "wait": {
      const config = await loadStoredConfig();
      const session = await resolveSession(positional[0]);
      const operation = positional[1] || config.lastOperation;
      if (!operation) throw new Error("An operation ID is required");
      const result = await jsonApi(
        `/v1/sessions/${encodeURIComponent(session)}/operations/${encodeURIComponent(operation)}`
      );
      if (flags.json) print(result, true);
      else if (result.status === "done") console.log(result.text || "Completed with no response.");
      else console.log(`Operation ${result.status}: ${result.reason || "no result"}`);
      return;
    }

    case "abort":
    case "stop": {
      const session = await resolveSession(positional[0]);
      const result = await jsonApi(
        `/v1/sessions/${encodeURIComponent(session)}/${command}`,
        { method: "POST" }
      );
      if (flags.json) print(result, true);
      else if (command === "stop") console.log(`Stop requested for ${session}.`);
      else console.log(result.aborted ? `Aborted ${session}.` : `Nothing to abort for ${session}.`);
      return;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;

    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

export const HELP = `cf-codex — opt-in Codex sessions in Cloudflare Containers

Usage:
  cf-codex configure --url <worker-url> --token <token>
  cf-codex start [prompt] [--repo <public-url>] [--ref <git-ref>]
  cf-codex login [session-id]
  cf-codex auth [session-id]
  cf-codex prompt [session-id] [prompt]
  cf-codex status [session-id]
  cf-codex messages [session-id]
  cf-codex logs [session-id] [--json]
  cf-codex wait [session-id] [operation-id]
  cf-codex abort [session-id]
  cf-codex stop [session-id]

The most recently used session and operation are used when IDs are omitted.
Prompts may also be provided through --prompt or stdin.

Environment overrides:
  CF_CODEX_URL
  CF_CODEX_TOKEN`;

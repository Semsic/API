const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 10000);
const PRESENCE_TTL_MS = 90_000;
const MAX_EVENTS = 2_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9_ -]{1,32}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const presence = new Map();
const events = [];
let nextEventId = 1;
const requestBuckets = new Map();

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Allow-Headers": "Content-Type",
                  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(body);
}

function cleanPresence() {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [username, entry] of presence) {
        if (entry.lastSeen < cutoff) presence.delete(username);
    }
}

function normalizeUsername(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateIdentity(body) {
    const username = normalizeUsername(body.username);
    if (!body.authenticated || !username || username.length > MAX_USERNAME_LENGTH ||
        !USERNAME_PATTERN.test(username)) {
        return { error: "authenticated username is required" };
        }

        const color = typeof body.color === "string" && COLOR_PATTERN.test(body.color)
        ? body.color.toUpperCase()
        : "#FFFFFF";
    return { username, color };
}

function consumeRateLimit(username, action) {
    const key = `${username}:${action}`;
    const now = Date.now();
    const bucket = requestBuckets.get(key) || { startedAt: now, count: 0 };
    if (now - bucket.startedAt >= 10_000) {
        bucket.startedAt = now;
        bucket.count = 0;
    }
    bucket.count += 1;
    requestBuckets.set(key, bucket);
    return bucket.count <= (action === "poll" ? 20 : 10);
}

function addEvent({ kind, sender, target, message, color }) {
    const event = {
        id: String(nextEventId++),
        kind,
        sender,
        target: target || null,
        message,
        color,
        createdAt: new Date().toISOString(),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    return event;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body is too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch {
                reject(new Error("request body must be valid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function validateMessage(body, identity) {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > MAX_MESSAGE_LENGTH) {
        return { error: `message must contain 1-${MAX_MESSAGE_LENGTH} characters` };
    }

    const target = body.target == null ? "" : normalizeUsername(body.target);
    if (target && (!USERNAME_PATTERN.test(target) || target.length > MAX_USERNAME_LENGTH)) {
        return { error: "target username is invalid" };
    }
    if (target === identity.username) return { error: "you cannot message yourself" };
    return { message, target };
}

async function handle(req, res) {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    cleanPresence();

    if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "sync-irc", users: presence.size });
    }

    if (req.method === "POST" && url.pathname === "/api/presence") {
        try {
            const body = await readJson(req);
            if (!body.authenticated) {
                if (body.username) presence.delete(normalizeUsername(body.username));
                return json(res, 200, { ok: true });
            }
            const identity = validateIdentity(body);
            if (identity.error) return json(res, 400, identity);
            if (!consumeRateLimit(identity.username, "presence")) {
                return json(res, 429, { error: "presence rate limit exceeded" });
            }
            presence.set(identity.username, { lastSeen: Date.now(), color: identity.color });
            return json(res, 200, { ok: true, username: identity.username });
        } catch (error) {
            return json(res, 400, { error: error.message });
        }
    }

    if (req.method === "POST" && url.pathname === "/api/online") {
        try {
            const body = await readJson(req);
            const identity = validateIdentity(body);
            if (identity.error) return json(res, 400, identity);
            if (!consumeRateLimit(identity.username, "online")) {
                return json(res, 429, { error: "online rate limit exceeded" });
            }
            presence.set(identity.username, { lastSeen: Date.now(), color: identity.color });
            return json(res, 200, { users: [...presence.keys()].sort() });
        } catch (error) {
            return json(res, 400, { error: error.message });
        }
    }

    if (req.method === "POST" && url.pathname === "/api/events/poll") {
        try {
            const body = await readJson(req);
            const identity = validateIdentity(body);
            if (identity.error) return json(res, 400, identity);
            if (!consumeRateLimit(identity.username, "poll")) {
                return json(res, 429, { error: "poll rate limit exceeded" });
            }
            presence.set(identity.username, { lastSeen: Date.now(), color: identity.color });
            const cursor = Number.parseInt(String(body.cursor || "0"), 10) || 0;
            const visible = events.filter((event) =>
            Number(event.id) > cursor &&
            event.sender !== identity.username &&
            (event.target === null || event.target === identity.username)
            );
            return json(res, 200, {
                cursor: String(nextEventId - 1),
                        events: visible,
                        online: [...presence.keys()].sort(),
            });
        } catch (error) {
            return json(res, 400, { error: error.message });
        }
    }

    if (req.method === "POST" &&
        (url.pathname === "/api/chat" || url.pathname === "/api/whisper")) {
        try {
            const body = await readJson(req);
            const identity = validateIdentity(body);
            if (identity.error) return json(res, 400, identity);
            const action = url.pathname === "/api/chat" ? "chat" : "whisper";
            if (!consumeRateLimit(identity.username, action)) {
                return json(res, 429, { error: "message rate limit exceeded" });
            }
            const message = validateMessage(body, identity);
            if (message.error) return json(res, 400, message);
            if (action === "whisper" && !message.target) {
                return json(res, 400, { error: "target username is required" });
            }
            if (message.target && !presence.has(message.target)) {
                return json(res, 404, { error: "target user is not online" });
            }
            const event = addEvent({
                kind: action,
                sender: identity.username,
                target: action === "whisper" ? message.target : null,
                message: message.message,
                color: identity.color,
            });
            return json(res, 201, { ok: true, eventId: event.id });
        } catch (error) {
            return json(res, 400, { error: error.message });
        }
        }

        return json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
        if (!res.headersSent) json(res, 500, { error: "internal server error" });
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Sync IRC API listening on port ${PORT}`);
});

// Direct Slack Web API client. Replaces the Cowork Slack MCP connector — this hosted app
// authenticates with its own bot token instead. The bot must be invited into both the
// shipping/releases channel and the product-ideas channel (see README).
const config = require("./config");

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function slackRequest(method, params, retries) {
  retries = retries == null ? 5 : retries;
  if (!config.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not set");
  const url = new URL("https://slack.com/api/" + method);
  Object.keys(params || {}).forEach((k) => {
    if (params[k] != null) url.searchParams.set(k, params[k]);
  });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "Authorization": "Bearer " + config.SLACK_BOT_TOKEN } });
    } catch (e) {
      if (attempt < retries) { await sleep(Math.min(8000, 500 * Math.pow(1.7, attempt))); continue; }
      throw e;
    }
    const json = await res.json().catch(() => null);
    if (json && json.error === "ratelimited" && attempt < retries) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (!json || !json.ok) {
      throw new Error("Slack API error (" + method + "): " + ((json && json.error) || ("HTTP " + res.status)));
    }
    return json;
  }
}

const userNameCache = {};
async function resolveUserName(userId) {
  if (!userId) return "";
  if (userNameCache[userId]) return userNameCache[userId];
  try {
    const data = await slackRequest("users.info", { user: userId });
    const name = (data.user && (data.user.profile.display_name || data.user.profile.real_name || data.user.name)) || userId;
    userNameCache[userId] = name;
    return name;
  } catch (e) {
    return userId;
  }
}

function permalinkFor(channelId, ts) {
  return "https://" + config.SLACK_WORKSPACE + ".slack.com/archives/" + channelId + "/p" + ts.replace(".", "");
}

// Many integration bots (GitHub notifications, etc.) post rich Block Kit messages where the
// top-level `text` field is just a short fallback ("A new release was published") and the real
// content lives in `blocks`. This flattens the common block types back into readable text so
// regexes like parseReleaseVersions() see the same content a human sees in Slack.
function richTextElementToString(el) {
  if (!el) return "";
  if (el.type === "text") return el.text || "";
  if (el.type === "link") return (el.text && el.text !== el.url) ? (el.text + " (" + el.url + ")") : (el.url || el.text || "");
  if (el.type === "user") return "@" + (el.user_id || "");
  if (el.type === "channel") return "#" + (el.channel_id || "");
  if (el.type === "emoji") return el.name ? (":" + el.name + ":") : "";
  return el.text || "";
}
function richTextBlockToString(block) {
  const lines = [];
  (block.elements || []).forEach((section) => {
    if (section.type === "rich_text_section") {
      const t = (section.elements || []).map(richTextElementToString).join("");
      if (t) lines.push(t);
    } else if (section.type === "rich_text_list") {
      (section.elements || []).forEach((item) => {
        const t = (item.elements || []).map(richTextElementToString).join("");
        lines.push("• " + t);
      });
    } else if (section.type === "rich_text_quote" || section.type === "rich_text_preformatted") {
      const t = (section.elements || []).map(richTextElementToString).join("");
      if (t) lines.push(t);
    }
  });
  return lines.join("\n");
}
function blocksToText(blocks) {
  const parts = [];
  (blocks || []).forEach((block) => {
    if (block.type === "rich_text") {
      const t = richTextBlockToString(block);
      if (t) parts.push(t);
    } else if ((block.type === "section" || block.type === "header") && block.text && block.text.text) {
      parts.push(block.text.text);
    } else if (block.type === "context") {
      const t = (block.elements || []).map((e) => e.text || "").filter(Boolean).join(" ");
      if (t) parts.push(t);
    }
  });
  return parts.join("\n");
}
// Strips common Slack mrkdwn syntax so plain-text regexes (e.g. matching "Release vX deployed!")
// aren't tripped up by *bold*, <url|label> links, etc.
function mrkdwnToPlain(text) {
  if (!text) return "";
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, url, label) => label + " (" + url + ")")
    .replace(/<([^>|]+)>/g, (_, url) => url)
    .replace(/(^|\s)[*_~]+(\S)/g, "$1$2")
    .replace(/(\S)[*_~]+(\s|$)/g, "$1$2");
}
// The single source of truth for "what does this message actually say" — prefers block content
// (richer/more complete for app integrations) and falls back to the plain text field.
function messageBodyText(msg) {
  const fromBlocks = mrkdwnToPlain(blocksToText(msg.blocks)).trim();
  const fromText = mrkdwnToPlain(msg.text || "").trim();
  return fromBlocks || fromText;
}

// Fetches every message in [startDate, endDate] from a channel, oldest-first, resolving a
// display name for each message (bot name for bot messages, real name for humans).
async function fetchChannelMessagesInWindow(channelId, startDate, endDate) {
  const oldest = (startDate.getTime() / 1000).toFixed(6);
  const latest = (endDate.getTime() / 1000).toFixed(6);
  let out = [];
  let cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const data = await slackRequest("conversations.history", { channel: channelId, oldest, latest, limit: 200, cursor, inclusive: true });
    const msgs = data.messages || [];
    for (const msg of msgs) {
      let name = "";
      if (msg.bot_id || msg.subtype === "bot_message") {
        name = (msg.bot_profile && msg.bot_profile.name) || msg.username || "Bot";
      } else if (msg.user) {
        name = await resolveUserName(msg.user);
      }
      out.push({
        ts: msg.ts,
        epochMs: parseFloat(msg.ts) * 1000,
        name,
        body: messageBodyText(msg),
        permalink: permalinkFor(channelId, msg.ts),
        hasThread: !!(msg.reply_count && msg.reply_count > 0)
      });
    }
    cursor = data.response_metadata && data.response_metadata.next_cursor;
    if (!cursor) break;
  }
  out.sort((a, b) => a.epochMs - b.epochMs);
  return out;
}

async function fetchThreadReplyText(channelId, threadTs) {
  const data = await slackRequest("conversations.replies", { channel: channelId, ts: threadTs, limit: 50 });
  const msgs = data.messages || [];
  return msgs.map((m) => messageBodyText(m)).join("\n");
}

// Debug helper: returns the last few raw messages from a channel (no date filter) with both the
// raw text and the computed body, so mismatches in release/idea parsing can be diagnosed without
// needing direct Slack API access. Hit GET /api/debug/channel-sample?channel=shipping|ideas.
async function debugRecentMessages(channelId, limit) {
  const data = await slackRequest("conversations.history", { channel: channelId, limit: limit || 5 });
  return (data.messages || []).map((m) => ({
    ts: m.ts,
    hasBlocks: !!(m.blocks && m.blocks.length),
    rawText: m.text || "",
    computedBody: messageBodyText(m)
  }));
}

function parseReleaseVersions(body) {
  if (!body) return null;
  const firstLine = (body.split("\n")[0] || "");
  const m = /^Releases?\s+(.+?)\s+deployed!/i.exec(firstLine.trim());
  if (!m) return null;
  return m[1].split(",").map((v) => v.trim()).filter(Boolean);
}

function firstLineSummary(body, maxLen) {
  let line = ((body || "").split("\n")[0] || "").trim();
  if (!line) line = (body || "").trim();
  if (line.length > maxLen) line = line.slice(0, maxLen - 1) + "…";
  return line || "(no text)";
}

function extractLinearIssueId(body) {
  if (!body) return null;
  const confirmRe = /(?:Created issue|Added (?:it|this)(?: to)?(?: issue)?|Linked (?:it|this)(?: to)?(?: issue)?)[^\n]*?linear\.app\/[\w-]+\/issue\/([A-Za-z]+-\d+)/i;
  let m = confirmRe.exec(body);
  if (m) return m[1].toUpperCase();
  m = /linear\.app\/[\w-]+\/issue\/([A-Za-z]+-\d+)/i.exec(body);
  if (m) return m[1].toUpperCase();
  m = /\b([A-Z]{2,10}-\d{1,6})\b/.exec(body);
  return m ? m[1] : null;
}

async function fetchReleases(startDate, endDate) {
  const msgs = await fetchChannelMessagesInWindow(config.SHIPPING_CHANNEL_ID, startDate, endDate);
  const results = [];
  msgs.forEach((msg) => {
    const versions = parseReleaseVersions(msg.body);
    if (!versions) return;
    results.push({
      id: "release:" + msg.ts,
      text: versions.join(", "),
      url: msg.permalink,
      meta: new Date(msg.epochMs).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      body: msg.body
    });
  });
  return results;
}

async function fetchProductIdeaMessages(startDate, endDate) {
  const msgs = await fetchChannelMessagesInWindow(config.PRODUCT_IDEAS_CHANNEL_ID, startDate, endDate);
  const results = [];
  msgs.forEach((msg) => {
    if (!msg.body || !msg.body.trim()) return;
    results.push({
      id: "idea:" + msg.ts,
      ts: msg.ts,
      text: firstLineSummary(msg.body, 34),
      url: msg.permalink,
      when: new Date(msg.epochMs).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      submitter: msg.name || "",
      meta: new Date(msg.epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      body: msg.body,
      hasThread: !!msg.hasThread,
      linearRef: extractLinearIssueId(msg.body)
    });
  });
  return results;
}

// Resolves Linear ticket references that show up in a THREAD REPLY (e.g. the Linear Slack bot
// replying "Created issue <link>") rather than the parent message body.
async function resolveProductIdeaLinearRefs(results) {
  const needsThread = results.filter((it) => !it.linearRef && it.hasThread);
  for (const item of needsThread) {
    try {
      const text = await fetchThreadReplyText(config.PRODUCT_IDEAS_CHANNEL_ID, item.ts);
      const ref = extractLinearIssueId(text);
      if (ref) item.linearRef = ref;
    } catch (e) {
      console.error("Failed to read thread for " + item.id, e.message);
    }
  }
}

module.exports = {
  fetchReleases,
  fetchProductIdeaMessages,
  resolveProductIdeaLinearRefs,
  debugRecentMessages
};

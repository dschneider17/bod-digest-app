const express = require("express");
const path = require("path");
const db = require("./db");
const config = require("./config");
const { buildDigestSnapshot } = require("./digest");
const slack = require("./slack");

db.load();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Pull job (async, so a slow Linear/Slack pull never hits an HTTP timeout) ----------
let pullJob = { status: "idle", phase: "", startedAt: null, error: null, snapshotId: null };

function snapshotSummary(s) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    label: s.label,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    releaseCount: s.data.releaseCount,
    completedCount: s.data.completedCount
  };
}

app.get("/api/snapshots", (req, res) => {
  const state = db.getState();
  const list = state.snapshots.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(snapshotSummary);
  res.json({ snapshots: list });
});

app.get("/api/snapshots/latest", (req, res) => {
  const state = db.getState();
  if (!state.snapshots.length) return res.json({ snapshot: null });
  const latest = state.snapshots.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  res.json({ snapshot: latest });
});

app.get("/api/snapshots/:id", (req, res) => {
  const state = db.getState();
  const found = state.snapshots.find((s) => s.id === req.params.id);
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({ snapshot: found });
});

app.delete("/api/snapshots/:id", async (req, res) => {
  const state = db.getState();
  const before = state.snapshots.length;
  state.snapshots = state.snapshots.filter((s) => s.id !== req.params.id);
  if (state.snapshots.length === before) return res.status(404).json({ error: "Not found" });
  await db.flush();
  res.json({ ok: true });
});

app.get("/api/pull/status", (req, res) => {
  res.json(pullJob);
});

app.post("/api/pull", async (req, res) => {
  if (pullJob.status === "running") {
    return res.status(409).json({ error: "A pull is already running", job: pullJob });
  }
  const { windowStart, windowEnd, label } = req.body || {};
  if (!windowStart || !windowEnd) return res.status(400).json({ error: "windowStart and windowEnd are required (YYYY-MM-DD)" });
  if (!config.LINEAR_API_KEY || !config.SLACK_BOT_TOKEN) {
    return res.status(400).json({ error: "Server is missing LINEAR_API_KEY or SLACK_BOT_TOKEN — set them as environment variables and redeploy." });
  }

  pullJob = { status: "running", phase: "Starting…", startedAt: new Date().toISOString(), error: null, snapshotId: null };
  res.json({ started: true, job: pullJob });

  try {
    const snapshot = await buildDigestSnapshot(windowStart, windowEnd, (phase) => { pullJob.phase = phase; });
    const state = db.getState();
    const id = db.newId();
    const row = {
      id,
      createdAt: new Date().toISOString(),
      label: label || (windowStart + " – " + windowEnd),
      windowStart,
      windowEnd,
      data: snapshot.data,
      podsOverview: snapshot.podsOverview
    };
    state.snapshots.push(row);
    await db.flush();
    pullJob = { status: "done", phase: "Done", startedAt: pullJob.startedAt, error: null, snapshotId: id };
  } catch (e) {
    console.error("Pull failed", e);
    pullJob = { status: "error", phase: pullJob.phase, startedAt: pullJob.startedAt, error: (e && e.message) || String(e), snapshotId: null };
  }
});

// ---------- Notes (callouts / blockers / pod notes / project notes) ----------
app.get("/api/notes", (req, res) => {
  const state = db.getState();
  res.json({ notes: state.notes, favorites: state.favorites });
});

function topList(kind) {
  const state = db.getState();
  return kind === "callouts" ? state.notes.calloutsTop : state.notes.blockersTop;
}

app.post("/api/notes/top/:kind", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "callouts" && kind !== "blockers") return res.status(400).json({ error: "kind must be callouts or blockers" });
  const list = topList(kind);
  const note = { id: db.newId(), title: "", body: "" };
  list.unshift(note);
  await db.flush();
  res.json({ note });
});

app.put("/api/notes/top/:kind/:id", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "callouts" && kind !== "blockers") return res.status(400).json({ error: "kind must be callouts or blockers" });
  const list = topList(kind);
  const note = list.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  if (typeof req.body.title === "string") note.title = req.body.title;
  if (typeof req.body.body === "string") note.body = req.body.body;
  await db.flush();
  res.json({ note });
});

app.delete("/api/notes/top/:kind/:id", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "callouts" && kind !== "blockers") return res.status(400).json({ error: "kind must be callouts or blockers" });
  const state = db.getState();
  const key = kind === "callouts" ? "calloutsTop" : "blockersTop";
  state.notes[key] = state.notes[key].filter((n) => n.id !== req.params.id);
  await db.flush();
  res.json({ ok: true });
});

app.put("/api/notes/pod/:podName", async (req, res) => {
  const state = db.getState();
  if (db.PODS_FOR_NOTES.indexOf(req.params.podName) === -1) return res.status(400).json({ error: "Unknown pod" });
  state.notes.podOtherNotes[req.params.podName] = typeof req.body.text === "string" ? req.body.text : "";
  await db.flush();
  res.json({ ok: true });
});

app.put("/api/notes/project/:projectId", async (req, res) => {
  const state = db.getState();
  const { callout, blocker } = req.body || {};
  if (typeof callout === "string") state.notes.projectCallouts[req.params.projectId] = callout;
  if (typeof blocker === "string") state.notes.projectBlockers[req.params.projectId] = blocker;
  await db.flush();
  res.json({ ok: true });
});

app.post("/api/favorites/:itemId/toggle", async (req, res) => {
  const state = db.getState();
  const id = req.params.itemId;
  if (state.favorites[id]) delete state.favorites[id]; else state.favorites[id] = true;
  await db.flush();
  res.json({ favorited: !!state.favorites[id] });
});

// Diagnostic only — shows the last few raw Slack messages from either channel plus what the
// app computed as their "body" text, so parsing mismatches (e.g. release messages using rich
// Block Kit formatting) can be debugged without direct Slack API access.
app.get("/api/debug/channel-sample", async (req, res) => {
  const which = req.query.channel === "ideas" ? config.PRODUCT_IDEAS_CHANNEL_ID : config.SHIPPING_CHANNEL_ID;
  try {
    const messages = await slack.debugRecentMessages(which, 5);
    res.json({ channel: which, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    linearConfigured: !!config.LINEAR_API_KEY,
    slackConfigured: !!config.SLACK_BOT_TOKEN,
    triageThemesConfigured: !!config.ANTHROPIC_API_KEY
  });
});

app.listen(config.PORT, () => {
  console.log("BOD Digest app listening on port " + config.PORT);
});

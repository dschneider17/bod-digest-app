// Lightweight file-backed data store. No native dependencies (safe for Railway builds).
// Not a "real" database, but this app has a handful of concurrent editors at most, and every
// write is queued through a single in-process mutex, so there's no realistic corruption risk.
//
// Persisted shape:
// {
//   snapshots: [ { id, createdAt, label, windowStart, windowEnd, data, podsOverview } , ... ],
//   notes: {
//     calloutsTop: [ { id, title, body } ],
//     blockersTop: [ { id, title, body } ],
//     podOtherNotes: { Alpha: "", Beta: "", Gamma: "", Intern: "" },
//     projectCallouts: { [projectId]: "text" },
//     projectBlockers: { [projectId]: "text" }
//   },
//   favorites: { [itemId]: true }
// }

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const PODS_FOR_NOTES = ["Alpha", "Beta", "Gamma", "Intern"];

function defaultDb() {
  const podOtherNotes = {};
  PODS_FOR_NOTES.forEach((p) => { podOtherNotes[p] = ""; });
  return {
    snapshots: [],
    notes: {
      calloutsTop: [],
      blockersTop: [],
      podOtherNotes,
      projectCallouts: {},
      projectBlockers: {}
    },
    favorites: {}
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let state = null;

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    state = defaultDb();
    flushSync();
    return state;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const d = defaultDb();
    state = {
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : d.snapshots,
      notes: {
        calloutsTop: Array.isArray(parsed.notes && parsed.notes.calloutsTop) ? parsed.notes.calloutsTop : d.notes.calloutsTop,
        blockersTop: Array.isArray(parsed.notes && parsed.notes.blockersTop) ? parsed.notes.blockersTop : d.notes.blockersTop,
        podOtherNotes: Object.assign({}, d.notes.podOtherNotes, (parsed.notes && parsed.notes.podOtherNotes) || {}),
        projectCallouts: Object.assign({}, (parsed.notes && parsed.notes.projectCallouts) || {}),
        projectBlockers: Object.assign({}, (parsed.notes && parsed.notes.projectBlockers) || {})
      },
      favorites: Object.assign({}, parsed.favorites || {})
    };
  } catch (e) {
    console.error("Failed to read db.json, starting fresh:", e.message);
    state = defaultDb();
  }
  return state;
}

// Simple write queue so concurrent saves can't interleave and corrupt the file.
let writeChain = Promise.resolve();
function flush() {
  writeChain = writeChain.then(() => flushSync());
  return writeChain;
}
function flushSync() {
  ensureDataDir();
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function getState() {
  if (!state) load();
  return state;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  PODS_FOR_NOTES,
  load,
  flush,
  getState,
  newId
};

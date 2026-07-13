// Seeds a fake snapshot with no external API calls, purely so you can click around the UI
// locally before you have real Linear/Slack credentials wired up. Not used in production.
const db = require("../db");

db.load();
const state = db.getState();

const id = db.newId();
state.snapshots.push({
  id,
  createdAt: new Date().toISOString(),
  label: "Demo snapshot",
  windowStart: "2026-07-05",
  windowEnd: "2026-07-12",
  data: {
    lastRefreshed: new Date().toISOString(),
    windowStart: "2026-07-05",
    windowEnd: "2026-07-12",
    releaseItems: [
      { id: "release:1", text: "v2.14.0", url: "https://example.com", meta: "Mon, Jul 6, 2:30 PM", body: "Releases v2.14.0 deployed!\nFixed payer linking bug." }
    ],
    releaseCount: 1,
    completedCount: 2,
    triageItems: [
      { id: "completed:1", text: "Fix dashboard crash on Safari", url: "https://example.com", status: "In Production", statusType: "completed", createdAt: new Date().toISOString(), assignee: "Jordan Lee", tagTeam: "Engineering", hasProject: false }
    ],
    triageThemes: null,
    productIdeaItems: [
      { id: "idea:1", ts: "1.1", text: "Add bulk export for donor lists", url: "https://example.com", when: "Tue, Jul 7, 9:15 AM", submitter: "Alex Rivera", meta: "Jul 7", body: "Add bulk export for donor lists\nWould help with reporting.", hasThread: false, linearRef: null }
    ]
  },
  podsOverview: {
    fetchedAt: new Date().toISOString(),
    pods: [
      { pod: "Alpha", projects: [{ id: "proj1", name: "Payer Sync Revamp", url: "https://example.com", statusName: "In Progress", statusType: "started", completedCount: 3, totalCount: 5, issues: [] }] },
      { pod: "Beta", projects: [] },
      { pod: "Gamma", projects: [] },
      { pod: "Intern", projects: [] }
    ]
  }
});

db.flush().then(() => {
  console.log("Seeded demo snapshot " + id);
});

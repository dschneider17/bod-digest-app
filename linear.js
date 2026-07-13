// Direct Linear GraphQL API client. Replaces the Cowork Linear MCP connector the original
// artifact used — this hosted app authenticates with its own Linear personal API key instead.
const config = require("./config");

const LINEAR_URL = "https://api.linear.app/graphql";

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function linearRequest(query, variables, retries) {
  retries = retries == null ? 5 : retries;
  if (!config.LINEAR_API_KEY) throw new Error("LINEAR_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(LINEAR_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": config.LINEAR_API_KEY
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (e) {
      if (attempt < retries) { await sleep(Math.min(8000, 500 * Math.pow(1.7, attempt))); continue; }
      throw e;
    }
    if (res.status === 429 && attempt < retries) {
      await sleep(Math.min(8000, 500 * Math.pow(1.7, attempt)));
      continue;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && json.errors)) {
      const msg = (json && json.errors && json.errors.map((e) => e.message).join("; ")) || ("Linear API HTTP " + res.status);
      if (attempt < retries && /rate.?limit/i.test(msg)) { await sleep(Math.min(8000, 500 * Math.pow(1.7, attempt))); continue; }
      throw new Error("Linear API error: " + msg);
    }
    return json.data;
  }
}

const PROJECT_FIELDS = `
  id
  name
  url
  status { name type }
  labels(first: 20) { nodes { name } }
  teams(first: 5) { nodes { id name } }
`;

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  state { name type }
  assignee { name }
  project { id }
  cycle { id }
  createdAt
  updatedAt
  completedAt
  archivedAt
`;

async function fetchAllProjects(teamName) {
  const query = `
    query Projects($first: Int!, $after: String, $filter: ProjectFilter) {
      projects(first: $first, after: $after, filter: $filter) {
        nodes { ${PROJECT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const filter = { accessibleTeams: { some: { name: { eq: teamName } } } };
  let out = [];
  let after = undefined;
  for (let page = 0; page < 10; page++) {
    const data = await linearRequest(query, { first: 50, after, filter });
    const conn = data && data.projects;
    if (!conn) break;
    out = out.concat(conn.nodes || []);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function fetchProjectsRaw() {
  const byId = {};
  for (const team of config.LINEAR_TEAMS) {
    const projects = await fetchAllProjects(team);
    projects.forEach((pr) => { byId[pr.id] = pr; });
  }
  return Object.values(byId);
}

function podOf(project) {
  const labelNames = (project.labels && project.labels.nodes || []).map((l) => l.name);
  for (const pod of config.POD_ORDER) {
    if (labelNames.indexOf(pod) !== -1) return pod;
  }
  return null;
}

function normalizeIssue(i) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    status: i.state && i.state.name,
    statusType: i.state && i.state.type,
    assignee: i.assignee ? i.assignee.name : null,
    projectId: i.project ? i.project.id : null,
    cycleId: i.cycle ? i.cycle.id : null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    completedAt: i.completedAt,
    archivedAt: i.archivedAt
  };
}

async function fetchProjectIssues(projectId) {
  const query = `
    query Issues($first: Int!, $after: String, $filter: IssueFilter, $includeArchived: Boolean) {
      issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const filter = { project: { id: { eq: projectId } } };
  let out = [];
  let after = undefined;
  for (let page = 0; page < 5; page++) {
    const data = await linearRequest(query, { first: 100, after, filter, includeArchived: false });
    const conn = data && data.issues;
    if (!conn) break;
    out = out.concat((conn.nodes || []).map(normalizeIssue));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// Mirrors fetchAllIssues({team, state, updatedAt: "-P"+days+"D"}) from the artifact.
async function fetchTeamIssuesByState(teamName, stateName, sinceDays) {
  const query = `
    query Issues($first: Int!, $after: String, $filter: IssueFilter, $includeArchived: Boolean) {
      issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const filter = {
    team: { name: { eq: teamName } },
    state: { name: { eq: stateName } },
    updatedAt: { gte: "-P" + sinceDays + "D" }
  };
  let out = [];
  let after = undefined;
  for (let page = 0; page < 10; page++) {
    const data = await linearRequest(query, { first: 100, after, filter, includeArchived: false });
    const conn = data && data.issues;
    if (!conn) break;
    out = out.concat((conn.nodes || []).map(normalizeIssue));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function fetchCurrentCycleIds(allProjects) {
  const teamIds = {};
  (allProjects || []).forEach((pr) => {
    (pr.teams && pr.teams.nodes || []).forEach((t) => { if (t && t.id) teamIds[t.id] = true; });
  });
  const ids = Object.keys(teamIds);
  const query = `
    query Cycles($filter: CycleFilter) {
      cycles(first: 10, filter: $filter) { nodes { id } }
    }
  `;
  const set = {};
  for (const teamId of ids) {
    try {
      const data = await linearRequest(query, { filter: { team: { id: { eq: teamId } }, isActive: { eq: true } } });
      (data && data.cycles && data.cycles.nodes || []).forEach((c) => { if (c && c.id) set[c.id] = true; });
    } catch (e) {
      console.error("Failed to fetch current cycle for team " + teamId, e.message);
    }
  }
  return set;
}

function isCountableIssue(i) {
  return !i.archivedAt && i.statusType !== "canceled";
}
function isCurrentCycleIssue(i, currentCycleIds) {
  return isCountableIssue(i) && !!i.cycleId && !!currentCycleIds[i.cycleId];
}
function sortCompletedFirst(issues) {
  return issues.slice().sort((a, b) => {
    const ac = a.statusType === "completed" ? 0 : 1;
    const bc = b.statusType === "completed" ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (ac === 0) return new Date(b.completedAt || 0) - new Date(a.completedAt || 0);
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}
function projectStatusRank(statusType) {
  if (statusType === "completed") return 0;
  if (statusType === "started") return 1;
  if (statusType === "unstarted" || statusType === "planned") return 2;
  return 3;
}

// Builds the Pods -> Projects -> current-cycle-issues overview, same shape as the artifact's
// fetchPodsOverview().
async function fetchPodsOverview(allProjects) {
  const qualifying = allProjects.filter((pr) => {
    const pod = podOf(pr);
    if (!pod || config.POD_FOUR.indexOf(pod) === -1) return false;
    const statusType = pr.status && pr.status.type;
    return statusType !== "backlog" && statusType !== "canceled";
  });
  const currentCycleIds = await fetchCurrentCycleIds(allProjects);
  const issuesByProject = {};
  for (const pr of qualifying) {
    try { issuesByProject[pr.id] = await fetchProjectIssues(pr.id); }
    catch (e) { console.error("Failed to fetch issues for project " + pr.name, e.message); issuesByProject[pr.id] = []; }
  }
  const pods = config.POD_FOUR.map((pod) => {
    let projects = qualifying.filter((pr) => podOf(pr) === pod).map((pr) => {
      const issues = sortCompletedFirst((issuesByProject[pr.id] || []).filter((i) => isCurrentCycleIssue(i, currentCycleIds)));
      return {
        id: pr.id,
        name: pr.name,
        url: pr.url,
        statusName: pr.status && pr.status.name,
        statusType: pr.status && pr.status.type,
        completedCount: issues.filter((i) => i.statusType === "completed").length,
        totalCount: issues.length,
        issues: issues.map((i) => ({ id: i.id, title: i.title, url: i.url, status: i.status, statusType: i.statusType, assignee: i.assignee }))
      };
    });
    projects.sort((a, b) => {
      const r = projectStatusRank(a.statusType) - projectStatusRank(b.statusType);
      if (r !== 0) return r;
      return b.completedCount - a.completedCount;
    });
    return { pod, projects };
  });
  return { fetchedAt: new Date().toISOString(), pods };
}

function daysBetween(a, b) { return Math.max(1, Math.ceil((b.getTime() - a.getTime()) / (24 * 3600 * 1000)) + 1); }
function inWindow(iso, start, end) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

// "Triage" in this dashboard = completed tickets NOT tied to a project (ad hoc/unplanned work),
// not Linear's "Triage" workflow state. Mirrors fetchCompleted() + the triageItems filter.
async function fetchCompletedAndTriage(startDate, endDate) {
  const days = daysBetween(startDate, new Date());
  let all = [];
  for (const team of config.LINEAR_TEAMS) {
    const issues = await fetchTeamIssuesByState(team, config.COMPLETED_STATE_NAME, days);
    issues.forEach((i) => {
      if (inWindow(i.completedAt, startDate, endDate)) {
        all.push({
          id: "completed:" + i.id,
          text: i.title,
          url: i.url,
          status: i.status,
          statusType: i.statusType,
          createdAt: i.createdAt,
          assignee: i.assignee,
          tagTeam: team,
          hasProject: !!i.projectId
        });
      }
    });
  }
  const triageItems = all.filter((i) => !i.hasProject).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { completed: all, triageItems };
}

// Resolves a Linear issue by its human identifier, e.g. "PRODUCT-468".
async function fetchIssueByIdentifier(identifier) {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(identifier || "");
  if (!m) return null;
  const teamKey = m[1].toUpperCase();
  const number = parseInt(m[2], 10);
  const query = `
    query IssueByNumber($filter: IssueFilter) {
      issues(first: 1, filter: $filter) {
        nodes { id title url state { name type } team { name } }
      }
    }
  `;
  const data = await linearRequest(query, { filter: { team: { key: { eq: teamKey } }, number: { eq: number } } });
  const node = data && data.issues && data.issues.nodes && data.issues.nodes[0];
  if (!node) return null;
  return { title: node.title, url: node.url, status: node.state && node.state.name, statusType: node.state && node.state.type, team: node.team && node.team.name };
}

module.exports = {
  fetchProjectsRaw,
  fetchPodsOverview,
  fetchCompletedAndTriage,
  fetchIssueByIdentifier,
  podOf
};

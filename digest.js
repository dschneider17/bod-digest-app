// Orchestrates a single manual "pull" — mirrors refreshAll() from the original artifact,
// but runs server-side with real Linear/Slack API credentials and saves the result as a new
// row in permanent, shared history (see db.js) rather than to a per-browser localStorage.
const config = require("./config");
const linear = require("./linear");
const slack = require("./slack");

// Best-effort: groups triage ticket titles into ~3 themes using Anthropic's API directly.
// Skipped entirely if ANTHROPIC_API_KEY isn't set — triage just renders ungrouped.
async function computeTriageThemes(items) {
  if (!items || items.length < 3 || !config.ANTHROPIC_API_KEY) return null;
  try {
    const prompt = "Group these triage ticket titles into exactly 3 short high-level themes. " +
      "Each theme name must be SHORT: 1-2 words maximum, a single clear noun phrase (e.g. 'Billing', 'Payer Linking', 'Dashboard'). " +
      "Never join multiple concepts with '&' or 'and'. These are all triage/bug tickets, so a generic theme like 'Bug Fixes' or 'Bugs' is useless — do NOT use one. " +
      "Instead find substantive, differentiated themes based on the actual subject matter. " +
      "Every ticket id must appear in exactly one theme. " +
      "Respond with ONLY minified JSON, no markdown or commentary, in this exact shape: " +
      "{\"themes\":[{\"name\":\"Theme name\",\"ticketIds\":[\"id1\",\"id2\"]}]}\n\n" +
      "Tickets:\n" + items.map((i) => i.id + ": " + i.text).join("\n");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const json = await res.json();
    const text = json && json.content && json.content[0] && json.content[0].text;
    const jsonMatch = /\{[\s\S]*\}/.exec(text || "");
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (!parsed || !Array.isArray(parsed.themes)) return null;
    const validIds = {};
    items.forEach((i) => { validIds[i.id] = true; });
    return parsed.themes.map((t) => {
      const ids = (t.ticketIds || []).filter((id) => validIds[id]);
      return { name: t.name || "Other", count: ids.length };
    }).filter((t) => t.count > 0);
  } catch (e) {
    console.error("Failed to compute triage themes", e.message);
    return null;
  }
}

// windowStart/windowEnd are "YYYY-MM-DD" strings (inclusive, local calendar days).
async function buildDigestSnapshot(windowStart, windowEnd, onPhase) {
  const phase = onPhase || function () {};
  const startDate = new Date(windowStart + "T00:00:00");
  const endDate = new Date(windowEnd + "T23:59:59");

  phase("Fetching Linear projects…");
  const allProjects = await linear.fetchProjectsRaw();

  phase("Fetching releases, completed tickets & pod projects…");
  const [releaseItems, completedAndTriage, podsOverview, productIdeaItems] = await Promise.all([
    slack.fetchReleases(startDate, endDate),
    linear.fetchCompletedAndTriage(startDate, endDate),
    linear.fetchPodsOverview(allProjects),
    slack.fetchProductIdeaMessages(startDate, endDate)
  ]);

  phase("Resolving Linear tickets referenced in product ideas…");
  await slack.resolveProductIdeaLinearRefs(productIdeaItems);
  for (const item of productIdeaItems) {
    if (item.linearRef && !item.linearIssue) {
      try { item.linearIssue = await linear.fetchIssueByIdentifier(item.linearRef); }
      catch (e) { console.error("Failed to resolve Linear ref " + item.linearRef, e.message); }
    }
  }

  phase("Summarizing triage themes…");
  const triageThemes = await computeTriageThemes(completedAndTriage.triageItems);

  const data = {
    lastRefreshed: new Date().toISOString(),
    windowStart,
    windowEnd,
    releaseItems,
    releaseCount: releaseItems.length,
    completedCount: completedAndTriage.completed.length,
    triageItems: completedAndTriage.triageItems,
    triageThemes,
    productIdeaItems
  };

  return { data, podsOverview };
}

module.exports = { buildDigestSnapshot };

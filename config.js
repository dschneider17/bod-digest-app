// Business-logic constants ported from the original Cowork artifact (bod-digest.html).
// Edit these if your Linear teams/labels or Slack channels differ.

module.exports = {
  LINEAR_API_KEY: process.env.LINEAR_API_KEY || "",
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "",
  SLACK_WORKSPACE: process.env.SLACK_WORKSPACE || "givechariot",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "", // optional: enables triage theme grouping

  LINEAR_TEAMS: ["Engineering", "Product"],
  COMPLETED_STATE_NAME: "In Production", // the Linear workflow state name that counts as "done"

  // Project label -> pod name. A project belongs to a pod if it has one of these labels.
  POD_ORDER: ["Alpha", "Beta", "Gamma", "Omega", "Intern"],
  POD_FOUR: ["Alpha", "Beta", "Gamma", "Intern"], // pods shown in the Pods Overview section

  SHIPPING_CHANNEL_ID: process.env.SHIPPING_CHANNEL_ID || "C08HRP8VAMB",
  PRODUCT_IDEAS_CHANNEL_ID: process.env.PRODUCT_IDEAS_CHANNEL_ID || "C09AE2ATY6M",

  PORT: process.env.PORT || 3000
};

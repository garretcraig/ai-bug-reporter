# AI Bug Reporter

A command-line tool that turns plain English bug descriptions and screenshots into structured, professional Jira tickets using Claude AI.

## What It Does

Describe a bug in plain English, optionally attach a screenshot, and the tool generates a complete, properly formatted Jira ticket and pushes it directly to your project — including severity, priority, steps to reproduce, and technical notes for developers.

Supports six ticket types: Bug, Task, Story, Sub-Task, Epic, and Spike.

**Key features:**
- Natural language input → structured Jira ticket
- Screenshot analysis via Claude vision (clipboard or file path)
- Video attachment support (attached to Jira, no AI analysis)
- Local duplicate and related issue detection (no extra API cost)
- Workspace context memory (saves known products and features)
- Pushes directly to Jira with file attachments
- ISTQB-aligned severity and priority classification

## Requirements

- Node.js v18+
- Anthropic API key
- Jira account with API token

## Setup

**1. Clone the repo**
```bash
git clone https://github.com/garretcraig/ai-bug-reporter.git
cd ai-bug-reporter
```

**2. Install dependencies**
```bash
npm install
```

**3. Create a `.env` file** (copy from `.env.example`)
```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your_jira_api_token_here
JIRA_PROJECT_KEY=YOUR_PROJECT_KEY
```

Get your Jira API token at: https://id.atlassian.com/manage-profile/security/api-tokens

**4. Run**
```bash
node index.js
```

## Usage

```
╔══════════════════════════════════════════════╗
║           AI Bug Reporter  v1.0              ║
╚══════════════════════════════════════════════╝

Ticket type:
  1. Bug
  2. Task
  3. Story
  4. Sub-Task
  5. Epic
  6. Spike

Choose (1-6):
> 1

→ Creating: Bug

Describe the bug:
> On the checkout page, clicking "Place Order" with an empty cart shows a 500 error instead of a validation message

Screenshot or video:
  c  → use clipboard
  f  → enter a file path
  s  → skip
```

Claude generates the full ticket, checks for duplicates against previously saved tickets, then asks if you want to save locally and push to Jira.

## Notes

- The severity field maps to `customfield_10096` in Jira. If your Jira instance uses a different field ID for severity, update line 222 in `index.js`.
- The Spike issue type requires a custom issue type named "Spike" in your Jira project. Standard issue types (Bug, Task, Story, Epic, Subtask) work out of the box.
- Saved tickets are stored in a `tickets/` folder organized by date. This folder is gitignored.

## Tech Stack

Node.js · Claude API (Anthropic) · Jira REST API v3 · Atlassian Document Format (ADF)

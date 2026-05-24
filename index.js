const Anthropic = require('@anthropic-ai/sdk');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const client = new Anthropic();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const JIRA_HOST        = (process.env.JIRA_URL || '').replace('https://', '').replace('http://', '');
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── Context ────────────────────────────────────────────────────────────────

function loadContext() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('context.json'), 'utf8'));
  } catch {
    return {
      team: '', products: [], features: {},
      story_point_format: null,
      priority_levels: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
      severity_levels: ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'],
      jira: { connected: false }
    };
  }
}

function saveContext(context) {
  fs.writeFileSync(path.resolve('context.json'), JSON.stringify(context, null, 2));
}

async function checkForNewProduct(ticketText, context) {
  const match = ticketText.match(/\*\*Title:\*\*\s*([^:\n]+):/);
  if (!match) return context;
  const detected = match[1].trim();
  if (!context.products.includes(detected)) {
    const save = await ask(`\nNew product detected: "${detected}"\nSave to workspace context? (y/n): `);
    if (save.trim().toLowerCase() === 'y') {
      context.products.push(detected);
      saveContext(context);
      console.log(`✓ "${detected}" saved. Known products: ${context.products.join(', ')}`);
    }
  }
  return context;
}

// ─── Duplicate & Related Issue Detection ────────────────────────────────────

function extractKeywords(ticketText) {
  const titleMatch   = ticketText.match(/\*\*Title:\*\*\s*(.+)/);
  const summaryMatch = ticketText.match(/\*\*Summary\*\*\s*\n([^\n]+)/);
  const combined     = `${titleMatch?.[1] || ''} ${summaryMatch?.[1] || ''}`.toLowerCase();

  const stopWords = new Set(['the','a','an','is','are','was','were','to','of','in','on','at','for','with','and','or','not','be','has','have','had','it','its','this','that','from','when','after','before','by','as','if','so','then','into','which','about']);
  return combined
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

function getAllSavedTickets() {
  const ticketsDir = path.resolve('tickets');
  if (!fs.existsSync(ticketsDir)) return [];

  const files = [];
  const dateDirs = fs.readdirSync(ticketsDir);
  for (const dateDir of dateDirs) {
    const datePath = path.join(ticketsDir, dateDir);
    if (!fs.statSync(datePath).isDirectory()) continue;
    for (const file of fs.readdirSync(datePath)) {
      if (file.endsWith('.txt')) files.push(path.join(datePath, file));
    }
  }
  return files;
}

function searchForMatches(newTicketText) {
  const keywords   = extractKeywords(newTicketText);
  if (keywords.length === 0) return { duplicates: [], related: [] };

  const allFiles   = getAllSavedTickets();
  const duplicates = [];
  const related    = [];

  for (const filePath of allFiles) {
    try {
      const content    = fs.readFileSync(filePath, 'utf8').toLowerCase();
      const matchCount = keywords.filter(kw => content.includes(kw)).length;
      const score      = matchCount / keywords.length;
      const titleLine  = fs.readFileSync(filePath, 'utf8').match(/\*\*Title:\*\*\s*(.+)/);
      const title      = titleLine ? titleLine[1].trim() : path.basename(filePath);

      if (score >= 0.7)      duplicates.push({ filePath, title, score });
      else if (score >= 0.4) related.push({ filePath, title, score });
    } catch { continue; }
  }

  duplicates.sort((a, b) => b.score - a.score);
  related.sort((a, b) => b.score - a.score);

  return { duplicates: duplicates.slice(0, 3), related: related.slice(0, 5) };
}

async function runDuplicateCheck(newTicketText) {
  const { duplicates, related } = searchForMatches(newTicketText);
  const links = [];

  if (duplicates.length > 0) {
    console.log('\n⚠ POSSIBLE DUPLICATE DETECTED:');
    for (const dup of duplicates) {
      console.log(`\n  "${dup.title}" (${Math.round(dup.score * 100)}% match)`);
      const view = await ask('  View this ticket? (y/n): ');
      if (view.trim().toLowerCase() === 'y') {
        console.log('\n' + '─'.repeat(50));
        console.log(fs.readFileSync(dup.filePath, 'utf8'));
        console.log('─'.repeat(50));
      }
      const proceed = await ask('\n  File anyway? (y/n): ');
      if (proceed.trim().toLowerCase() !== 'y') {
        console.log('  Ticket abandoned.');
        return null;
      }
      links.push(`**Possible Duplicate:** ${dup.title}`);
    }
  }

  if (related.length > 0) {
    console.log('\n📎 RELATED ISSUES FOUND:');
    for (const rel of related) {
      console.log(`  · "${rel.title}" (${Math.round(rel.score * 100)}% related)`);
      links.push(`**Relates To:** ${rel.title}`);
    }
  }

  return links;
}

// ─── Image ──────────────────────────────────────────────────────────────────

function getClipboardImage() {
  const tmpPath = path.join(os.tmpdir(), `clipboard_${Date.now()}.png`);
  const cmd = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${tmpPath}'); Write-Output 'saved' } else { Write-Output 'empty' }`;
  try {
    const result = execSync(`powershell -Command "${cmd}"`, { stdio: 'pipe' }).toString().trim();
    return (result === 'saved' && fs.existsSync(tmpPath)) ? tmpPath : null;
  } catch { return null; }
}

function loadImage(imagePath) {
  const ext  = path.extname(imagePath).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  return { data: fs.readFileSync(imagePath.trim()).toString('base64'), mimeType: mime[ext] || 'image/png' };
}

// ─── Save Tickets ────────────────────────────────────────────────────────────

function saveTicket(content, ticketType, product, feature) {
  const today = new Date().toISOString().slice(0, 10);
  const dir   = path.resolve('tickets', today);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = [product, feature].filter(Boolean).join('-').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || ticketType.toLowerCase();
  const base = `${ts}-${slug}`;
  fs.writeFileSync(path.join(dir, `${base}.txt`), content);
  fs.writeFileSync(path.join(dir, `${base}.md`), content);
  return path.join(dir, base);
}

// ─── Jira Integration ────────────────────────────────────────────────────────

function textToADF(text) {
  const lines   = text.split('\n');
  const content = [];
  let i         = 0;
  let inMetadata = true;

  while (i < lines.length) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed === '---') { i++; continue; }

    if (inMetadata) {
      if (/^\*\*(Title|Type|Priority|Severity|Software Component|Story Points|Parent Issue):\*\*/.test(trimmed)) {
        i++; continue;
      }
      inMetadata = false;
    }

    if (/^\*\*[^*:]+\*\*$/.test(trimmed)) {
      content.push({
        type: 'heading', attrs: { level: 3 },
        content: [{ type: 'text', text: trimmed.replace(/\*\*/g, '') }]
      });
      i++; continue;
    }

    if (/^[-•]\s/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-•]\s/.test(lines[i].trim())) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i].trim().replace(/^[-•]\s/, '').replace(/\*\*/g, '') }] }]
        });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: lines[i].trim().replace(/^\d+\.\s/, '').replace(/\*\*/g, '') }] }]
        });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    const clean = trimmed.replace(/\*\*/g, '');
    if (clean) content.push({ type: 'paragraph', content: [{ type: 'text', text: clean }] });
    i++;
  }

  return {
    type: 'doc', version: 1,
    content: content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: text }] }]
  };
}

async function attachFileToJira(issueKey, filePath) {
  const fileData = fs.readFileSync(filePath);
  const filename  = path.basename(filePath);
  const boundary  = '----FormBoundary' + Date.now();
  const header    = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const footer    = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body      = Buffer.concat([header, fileData, footer]);
  const auth      = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: JIRA_HOST,
      path:     `/rest/api/3/issue/${issueKey}/attachments`,
      method:   'POST',
      headers: {
        'Authorization':     'Basic ' + auth,
        'X-Atlassian-Token': 'no-check',
        'Content-Type':      `multipart/form-data; boundary=${boundary}`,
        'Content-Length':    body.length
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`Status ${res.statusCode}: ${d}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pushToJira(finalTicket, ticketType) {
  const issueTypeNames = {
    'Bug': 'Bug', 'Epic': 'Epic', 'Spike': 'Spike',
    'Story': 'Story', 'Sub-Task': 'Subtask', 'Task': 'Task'
  };

  const titleMatch    = finalTicket.match(/\*\*Title:\*\*\s*(.+)/);
  const summary       = titleMatch ? titleMatch[1].trim() : 'Untitled ticket';
  const priorityMatch = finalTicket.match(/\*\*Priority:\*\*\s*(.+)/);
  const priority      = priorityMatch ? priorityMatch[1].trim() : 'Medium';
  const severityMatch = finalTicket.match(/\*\*Severity:\*\*\s*(.+)/);
  const severity      = severityMatch ? severityMatch[1].trim() : null;
  const issueTypeName = issueTypeNames[ticketType] || 'Task';

  const fields = {
    project:     { key: JIRA_PROJECT_KEY },
    summary,
    issuetype:   { name: issueTypeName },
    priority:    { name: priority },
    description: textToADF(finalTicket)
  };

  if (severity) fields.customfield_10096 = { value: severity };

  const body = JSON.stringify({ fields });
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: JIRA_HOST,
      path:     '/rest/api/3/issue',
      method:   'POST',
      headers: {
        'Authorization':  'Basic ' + auth,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          result.key ? resolve(result.key) : reject(new Error(d));
        } catch { reject(new Error(d)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Ticket Structures ───────────────────────────────────────────────────────

function getTicketStructure(ticketType) {
  switch (ticketType) {
    case 'Epic': return `
EPIC STRUCTURE — use exactly:
**Title:** [Product]: [Brief Epic Name].
**Type:** Epic
**Priority:** [level]

**Summary**
[Single searchable sentence describing the epic goal]

**Goal**
[What this epic achieves for the product or business]

**Scope**
- [What is included]

**Out of Scope**
- [What is explicitly excluded]

**Acceptance Criteria**
- [Measurable condition for epic completion]

**Definition of Done**
- [ ] All child stories completed and QA verified
- [ ] Regression sweep passed
- [ ] Stakeholder sign-off received`;

    case 'Story': return `
STORY STRUCTURE — use exactly:
**Title:** [Product]: [Feature]: [Brief Description].
**Type:** Story
**Priority:** [level]
**Story Points:** [estimate] — [one sentence reasoning]

**Summary**
[Single searchable sentence describing what the user can do]

**User Story**
As a [role], I want to [action] so that [benefit].

**Acceptance Criteria**
- Given [context], when [action], then [outcome]

**Definition of Done**
- [ ] Code complete and peer reviewed
- [ ] Unit tests written
- [ ] QA verified in staging
- [ ] No open Blockers or Criticals

**Notes**
[Dependencies, edge cases, or additional context]`;

    case 'Task': return `
TASK STRUCTURE — use exactly:
**Title:** [Product]: [Feature]: [Brief Description].
**Type:** Task
**Priority:** [level]
**Software Component:** [component]

**Summary**
[Single searchable sentence describing what needs to be done]

**Objective**
[Clear definition of what needs to change or be built]

**Context**
[Business or operational reason behind this request]

**Technical Specifications**
- [Component names, field mappings, routing, database logic, layout requirements]

**Acceptance Criteria**
- [What done looks like for this task]`;

    case 'Sub-Task': return `
SUB-TASK STRUCTURE — use exactly:
**Title:** [Product]: [Feature]: [Brief Description].
**Type:** Sub-Task
**Parent Issue:** [number or TBD — remind user to link in Jira if TBD]
**Priority:** [level]
**Software Component:** [component]

**Summary**
[Single searchable sentence describing this specific piece of work]

**Objective**
[What specifically needs to be done in this sub-task]

**Technical Specifications**
- [Specific implementation details for this sub-task only]

**Acceptance Criteria**
- [What done looks like for this sub-task]`;

    case 'Bug':
    default: return `
BUG STRUCTURE — use exactly:
**Title:** [Product]: [Feature]: [Brief Description].
**Type:** Bug
**Priority:** [level]
**Severity:** [level]
**Software Component:** [component]

**Summary**
[Single searchable sentence describing the broken behavior]

**Preconditions**
- [Required states, data, or configuration before reproducing]

**Steps to Reproduce**
1. [Step]
2. [Step]
3. [Step]

**Actual Results**
- [What happens — include exact error messages, toast text, or failed states]

**Expected Results**
- [What should happen — be specific about UI states and behaviors]

**Technical Notes for Triage**
- [Selectors, API endpoints, error codes, or suspected root cause]
- [Point the developer toward the most likely location of the defect]

**Platform Compliance Notes** (include only when relevant)
- [Specific guideline name and requirement — Apple HIG, Google Play Policy, WCAG 2.1, TRC/TCR/XR, etc.]`;
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(context, ticketType, storyPointFormat, parentIssue) {
  const priorities = context.priority_levels.join(' / ');
  const severities = context.severity_levels.join(' / ');
  const spGuide    = storyPointFormat === '2'
    ? 'T-shirt sizes: XS (trivial) · S (simple) · M (moderate) · L (large) · XL (very large) · XXL (epic-scale)'
    : storyPointFormat === '3'
    ? 'Linear 1–10: 1–2 (trivial) · 3–4 (small) · 5–6 (moderate) · 7–8 (large) · 9–10 (very complex)'
    : 'Fibonacci: 1 (trivial) · 2 (simple) · 3 (small) · 5 (moderate) · 8 (large) · 13 (very large) · 21 (epic-scale)';

  const productCtx = context.products.length > 0
    ? `\nKNOWN PRODUCTS: ${context.products.join(', ')}\nKNOWN FEATURES:\n${Object.entries(context.features).map(([p, f]) => `  ${p}: ${f.join(', ')}`).join('\n')}\nUse this context to identify the product and feature from the screenshot or description without asking when it is obvious.`
    : '';

  return `You are an expert QA Engineer, Technical Writer, and Agile practitioner aligned with ISTQB standards. You create Jira tickets that are precise, highly scannable, and immediately actionable for development teams.
${productCtx}
CURRENT TICKET TYPE: ${ticketType}
${parentIssue ? `PARENT ISSUE: ${parentIssue}` : ''}
${ticketType === 'Story' ? `STORY POINT FORMAT: ${spGuide}` : ''}

ISTQB STANDARDS:
- Severity = technical impact on the system (independent of business urgency)
- Priority = business urgency (independent of technical severity)
- All bugs must be fully reproducible from the steps provided alone
- Risk-based priority: assess both likelihood of impact AND business consequence
- Summaries must be a single concise sentence using common, searchable terminology — not a paragraph

TITLE FORMAT (strict):
[Product]: [Page/Tab/Feature]: [Brief Description].
- Colons only between segments — no dashes
- End with a period
- No issue type in the title (no "UI Bug", "Functional Task", etc.)
- Use simple, searchable words a developer would search for in Jira

CRITICAL CLARIFICATION GUARDRAIL:
If you cannot clearly identify the Product or Feature from the input or screenshot, ask ONE short clarifying question. Do not generate the ticket until you have that information. Do not guess.

SOFTWARE COMPONENTS (pick the single best match):
- UI / Layout — visual defects, alignment, missing or broken UI elements
- Functional — features not working as expected, broken workflows
- Performance — slow loads, lag, timeouts, frame drops
- Authentication — login, logout, session handling, permissions, access control
- Navigation — routing, links, redirects, breadcrumbs, deep links
- Data / API — incorrect data, failed API calls, sync or database issues
- Stability / Crash — crashes, freezes, unrecoverable error states
- Accessibility — screen reader support, keyboard nav, color contrast

PRIORITY LEVELS (use exactly): ${priorities}
SEVERITY LEVELS (use exactly — bugs only): ${severities}

PLATFORM COMPLIANCE — check automatically when relevant:
- iOS: Apple Human Interface Guidelines + App Store Review Guidelines
- Android: Google Play Developer Policy + Material Design Guidelines
- Console: Platform TRC / TCR / XR certification requirements
- Web: WCAG 2.1 AA accessibility standards
When a ticket touches a compliance area, add a "Platform Compliance Notes" section citing the specific guideline so developers can address it before platform submission.

${getTicketStructure(ticketType)}

OUTPUT RULES:
- Generate the complete ticket — never truncate or summarize
- Summaries: one tight sentence only — never a paragraph
- Bullets: scannable and specific — no dense prose
- Technical notes: specific enough that a developer knows exactly where to look`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║           AI Bug Reporter  v1.0              ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let context = loadContext();
  if (context.team)            console.log(`Workspace:  ${context.team}`);
  if (context.products.length) console.log(`Products:   ${context.products.join(', ')}`);
  console.log();

  console.log('Ticket type:');
  console.log('  1. Bug');
  console.log('  2. Task');
  console.log('  3. Story');
  console.log('  4. Sub-Task');
  console.log('  5. Epic');
  console.log('  6. Spike');
  const typeChoice = (await ask('\nChoose (1-6):\n> ')).trim();
  const typeMap    = { '1': 'Bug', '2': 'Task', '3': 'Story', '4': 'Sub-Task', '5': 'Epic', '6': 'Spike' };
  const ticketType = typeMap[typeChoice] || 'Bug';
  console.log(`\n→ Creating: ${ticketType}\n`);

  let storyPointFormat = null;
  if (ticketType === 'Story') {
    if (context.story_point_format) {
      storyPointFormat = context.story_point_format;
      const names = { '1': 'Fibonacci', '2': 'T-shirt sizes', '3': 'Linear (1-10)' };
      console.log(`Story point format: ${names[storyPointFormat]} (saved default)\n`);
    } else {
      console.log('Story point format:');
      console.log('  1. Fibonacci (1, 2, 3, 5, 8, 13, 21) — recommended');
      console.log('  2. T-shirt sizes (XS, S, M, L, XL, XXL)');
      console.log('  3. Linear (1-10)');
      storyPointFormat = (await ask('\nChoose format (1/2/3):\n> ')).trim() || '1';
      const setDefault = await ask('Set as workspace default? (y/n): ');
      if (setDefault.trim().toLowerCase() === 'y') {
        context.story_point_format = storyPointFormat;
        saveContext(context);
        console.log('✓ Saved as default.\n');
      }
    }
  }

  let parentIssue = null;
  if (ticketType === 'Sub-Task') {
    const p = await ask('Parent issue number (press Enter to leave as TBD):\n> ');
    parentIssue = p.trim() || 'TBD';
    if (parentIssue === 'TBD') console.log('⚠ Remember to link the parent issue in Jira before closing the sprint.\n');
  }

  const descriptionPrompts = {
    'Bug':      'Describe the bug:\n> ',
    'Task':     'Describe the task:\n> ',
    'Story':    'Describe the story:\n> ',
    'Sub-Task': 'Describe the sub-task:\n> ',
    'Epic':     'Describe the epic:\n> ',
    'Spike':    'Describe the spike:\n> '
  };
  const description = await ask(descriptionPrompts[ticketType] || 'Describe the issue:\n> ');

  console.log('\nScreenshot or video:');
  console.log('  c  → use clipboard (take one first with Win+Shift+S)');
  console.log('  f  → enter a file path (image or video — attaches to Jira ticket)');
  console.log('  s  → skip');
  const imageChoice = (await ask('\nChoice (c/f/s):\n> ')).trim().toLowerCase();

  const messageContent = [];
  let attachmentPath   = null;

  if (imageChoice === 'c') {
    console.log('Reading clipboard...');
    const clipPath = getClipboardImage();
    if (clipPath) {
      try {
        const { data, mimeType } = loadImage(clipPath);
        messageContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
        attachmentPath = clipPath;
        console.log('✓ Clipboard screenshot loaded.\n');
      } catch { console.log('Could not read clipboard — continuing without it.\n'); }
    } else {
      console.log('No image found in clipboard — continuing without one.\n');
    }
  } else if (imageChoice === 'f') {
    const filePath = (await ask('File path:\n> ')).trim().replace(/^"|"$/g, '');
    const ext      = path.extname(filePath).toLowerCase();
    const videoExts = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    if (videoExts.includes(ext)) {
      if (fs.existsSync(filePath)) {
        attachmentPath = filePath;
        console.log('✓ Video queued for Jira attachment.\n');
      } else {
        console.log('File not found — continuing without it.\n');
      }
    } else {
      try {
        const { data, mimeType } = loadImage(filePath);
        messageContent.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
        attachmentPath = filePath;
        console.log('✓ Screenshot loaded.\n');
      } catch { console.log('Could not load image — continuing without it.\n'); }
    }
  } else {
    console.log('Skipping screenshot.\n');
  }

  messageContent.push({ type: 'text', text: description });

  const systemPrompt = buildSystemPrompt(context, ticketType, storyPointFormat, parentIssue);
  const history      = [{ role: 'user', content: messageContent }];
  let totalCost      = 0;
  let finalTicket    = null;

  console.log(`Generating ${ticketType} ticket...\n`);

  while (true) {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   history
    });

    const reply  = response.content[0].text;
    const input  = response.usage.input_tokens;
    const output = response.usage.output_tokens;
    const cost   = (input / 1_000_000 * 3.00) + (output / 1_000_000 * 15.00);
    totalCost   += cost;

    history.push({ role: 'assistant', content: reply });

    if (reply.includes('**Type:**')) {
      finalTicket = reply;
      console.log('\n' + '═'.repeat(60));
      console.log(finalTicket);
      console.log('═'.repeat(60));
      console.log(`\n[Total Cost: $${totalCost.toFixed(6)}]`);
      break;
    }

    console.log('\nClaude: ' + reply + '\n');
    const clarification = await ask('Your answer:\n> ');
    history.push({ role: 'user', content: clarification });
    console.log(`\nGenerating ${ticketType} ticket...\n`);
  }

  const links = await runDuplicateCheck(finalTicket);
  if (links === null) { rl.close(); return; }

  if (links.length > 0) {
    finalTicket += '\n\n**Linked Issues**\n' + links.map(l => `- ${l}`).join('\n');
    console.log('\n─── Updated ticket with linked issues ───');
    console.log(finalTicket);
  }

  context = await checkForNewProduct(finalTicket, context);

  const saveChoice = await ask('\nSave ticket to file? (y/n): ');
  if (saveChoice.trim().toLowerCase() === 'y') {
    const titleMatch = finalTicket.match(/\*\*Title:\*\*\s*([^:\n]+):\s*([^:\n]+):/);
    const product    = titleMatch ? titleMatch[1].trim() : '';
    const feature    = titleMatch ? titleMatch[2].trim() : '';
    const basePath   = saveTicket(finalTicket, ticketType, product, feature);
    console.log(`\n✓ Saved: ${basePath}.txt`);
  }

  const jiraChoice = await ask('\nPush to Jira? (y/n): ');
  if (jiraChoice.trim().toLowerCase() === 'y') {
    try {
      console.log('Creating Jira issue...');
      const issueKey = await pushToJira(finalTicket, ticketType);
      console.log(`\n✓ Created: ${issueKey}`);
      console.log(`  ${process.env.JIRA_URL}/browse/${issueKey}`);
      if (attachmentPath) {
        try {
          console.log('Attaching file...');
          await attachFileToJira(issueKey, attachmentPath);
          console.log(`✓ ${path.basename(attachmentPath)} attached.`);
        } catch (err) {
          console.log('✗ Attachment failed:', err.message);
        }
      }
    } catch (err) {
      console.log('\n✗ Jira push failed:', err.message);
    }
  }

  console.log('\nDone!');
  rl.close();
}

main().catch(console.error);

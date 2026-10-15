import type { Account, ActionItem, Attachment, CalendarEvent, Draft, Message, Source } from "../shared/contracts";

export function demoData() {
  const now = Date.now();
  const accounts: Account[] = [
    { id: "demo-gmail", provider: "gmail", name: "Sample workspace", email: "alex@example.com", status: "connected", aiEnabled: false, consent: true, demo: true },
    { id: "demo-slack", provider: "slack", name: "Sample team", email: "alex@example.com", status: "connected", aiEnabled: false, consent: true, demo: true },
    { id: "demo-microsoft", provider: "microsoft", name: "Sample projects", email: "alex@contoso.example", status: "connected", aiEnabled: false, consent: true, demo: true }
  ];
  const sources: Source[] = [
    { id: "demo-inbox", accountId: "demo-gmail", providerId: "INBOX", name: "Inbox", kind: "mail", selected: true },
    { id: "demo-product", accountId: "demo-slack", providerId: "product", name: "# product", kind: "channel", selected: true },
    { id: "demo-projects", accountId: "demo-microsoft", providerId: "inbox", name: "Projects", kind: "mail", selected: true },
    { id: "demo-calendar", accountId: "demo-gmail", providerId: "primary", name: "Work calendar", kind: "calendar", selected: true }
  ];
  const entries = [
    ["demo-gmail", "demo-inbox", "Maya Chen <maya@example.com>", "Launch review: your decision is needed", "Hi Alex,\n\nThe launch checklist is ready. Could you review the revised rollout plan and confirm whether we should keep the phased release? We need your feedback before the review meeting.\n\nThe attachment summarizes the risks and rollback options.\n\nThanks,\nMaya", 8],
    ["demo-slack", "demo-product", "Sam Rivera", "Design handoff - one open question", "The new onboarding screens are ready for engineering. @Alex can you confirm whether we keep the optional workspace step? This is the last open decision before handoff.", 23],
    ["demo-microsoft", "demo-projects", "Jordan Lee <jordan@example.com>", "Customer workshop agenda", "Hi Alex,\n\nHere's the proposed agenda for the customer workshop: goals, current workflow, and next steps. Please add any topics you'd like to cover.\n\nBest,\nJordan", 45],
    ["demo-gmail", "demo-inbox", "Priya Shah <priya@example.com>", "Re: Quarterly planning - waiting on finance", "Quick update: finance is reviewing the revised estimates. I'll share the approved numbers once they finish. No action needed from you for now.", 90],
    ["demo-slack", "demo-product", "Taylor Kim", "Customer feedback highlights", "Three themes from this week's interviews: simpler setup, clearer notifications, and faster search. I've captured the notes so we can discuss them at the next product review.", 140],
    ["demo-gmail", "demo-inbox", "Maya Chen <maya@example.com>", "Previous launch retrospective", "Our previous rollout showed that a phased release reduced support load. The agreed decision was to start with a small cohort, review errors, then expand. Keep rollback ownership explicit in the next plan.", 65000]
  ] as const;
  const messages: Message[] = entries.map((entry, index) => ({
    id: `demo-message-${index}`, accountId: entry[0], sourceId: entry[1], providerId: String(index),
    threadId: `demo-thread-${index}`, subject: entry[3], sender: entry[2], recipients: ["alex@example.com"], body: entry[4],
    receivedAt: new Date(now - entry[5] * 60000).toISOString(), url: "", unread: index < 3,
    revision: "sample-1", historical: index === 5
  }));
  messages[0].html = "<p>Hi Alex,</p><p>The <strong>launch checklist</strong> is ready. Could you review the revised rollout plan and confirm whether we should keep the <strong>phased release</strong>? We need your feedback before the review meeting.</p><p>The attachment summarizes the risks and rollback options.</p><p>Thanks,<br>Maya</p>";
  const actions: ActionItem[] = messages.slice(0, 3).map((message, index) => ({
    id: `demo-action-${index}`, messageId: message.id, accountId: message.accountId,
    title: ["Review the launch decision", "Resolve the onboarding question", "Prepare the workshop agenda"][index],
    reason: ["The sender explicitly requests a decision before the review meeting.", "You were mentioned in a question that blocks the design handoff.", "The workshop organizer requested agenda input."][index],
    priority: index === 0 ? "urgent" : "important", status: "open", confidence: 0.9,
    citations: [{ id: message.id, messageId: message.id, title: message.subject, excerpt: message.body }]
  }));
  const start = new Date(now);
  start.setHours(15, 0, 0, 0);
  const events: CalendarEvent[] = [{
    id: "demo-event", accountId: "demo-gmail", sourceId: "demo-calendar", providerId: "sample-event",
    title: "Launch readiness review", start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDay: false, attendees: ["maya@example.com"],
    location: "Video call", description: "Review rollout readiness and open decisions.", revision: "sample-1", url: "", writable: false
  }];
  const attachments: Attachment[] = [{
    id: "demo-attachment", accountId: "demo-gmail", messageId: messages[0].id, providerId: "sample-file",
    name: "rollout-plan.pdf", mimeType: "application/pdf", size: 27000000, status: "awaiting-approval",
    reason: "Synthetic attachment preview. Connect a real account to download and extract documents."
  }];
  const drafts: Draft[] = [{
    id: "demo-draft", accountId: "demo-gmail", messageId: messages[0].id,
    subject: `Re: ${messages[0].subject}`, recipients: ["maya@example.com"],
    body: "Hi Maya,\n\nThanks for sharing the rollout plan. Our previous retrospective favored a phased release with explicit rollback ownership. I'll review the updated risks before confirming the approach.\n\nBest,\nAlex\n\n[Sample text for exploring the editor, not an AI-generated response.]",
    updatedAt: new Date(now).toISOString(), sourceRevision: "sample-1", status: "local",
    citations: [{ id: messages[5].id, messageId: messages[5].id, title: messages[5].subject, excerpt: messages[5].body }]
  }];
  return { accounts, sources, messages, actions, events, attachments, drafts };
}

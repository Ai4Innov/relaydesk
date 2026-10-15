import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RichMessage, safeMessageUrl } from "../src/renderer/RichMessage";
import { ActionPreview } from "../src/renderer/ActionPreview";

const render = (text: string) => renderToStaticMarkup(<RichMessage text={text} copy={vi.fn()}/>);

describe("safe rich assistant messages", () => {
  it("renders semantic headings, emphasis, lists, quotes, code, and GFM tables", () => {
    const html = render("# Your day\n\n**Focus** on *one thing* and ~~distractions~~.\n\n- First\n- Second\n\n1. Next\n2. Last\n\n> Leave room\n\n`inline`\n\n```ts\nconst value = '<safe>';\n```\n\n| Time | Task |\n| --- | --- |\n| 09:00 | Review |\n\n- [x] Ready");
    for (const tag of ["h1", "strong", "em", "del", "ul", "ol", "blockquote", "code", "table", "th", "td"]) expect(html).toContain(`<${tag}`);
    expect(html).toContain("&lt;safe&gt;");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('aria-label="Response table"');
    expect(html).toContain('aria-label="Checked"');
    expect(html).not.toContain("<input");
  });

  it("does not render raw HTML, remote media, interactive links, or model supplied styles", () => {
    const html = render('Safe text\n\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<iframe src="https://bad.test"></iframe>\n\n<svg onload="alert(3)"></svg>\n\n<style>body{display:none}</style>\n\n![pixel](https://tracker.test/image)\n\n[Danger](javascript:alert%281%29) [Data](data:text/html,evil) [File](file:///C:/private) [Protocol relative](//tracker.test) [Good](https://example.org/path?q=ok)\n\n<div style="color:red">raw block</div>');
    expect(html).toContain("Safe text");
    expect(html).toContain("https://example.org/path?q=ok");
    expect(html).not.toMatch(/<(?:img|script|iframe|svg|style|a)(?:\s|>)/);
    for (const value of ["tracker.test", "javascript:", "data:text", "file://", "onerror", "onload", "style=", "alert(2)"]) expect(html).not.toContain(value);
  });

  it("accepts only explicit credential-free HTTP(S) addresses as inert text", () => {
    for (const url of ["javascript:alert(1)", "data:image/svg+xml,x", "https://user:pass@example.org", "//example.org", "/relative", "https://example.org\n", "https://"]) expect(safeMessageUrl(url)).toBeUndefined();
    expect(safeMessageUrl("https://example.org/path")).toBe("https://example.org/path");
    expect(safeMessageUrl("http://localhost:1234")).toBe("http://localhost:1234");
  });
});

describe("human-readable exact action previews", () => {
  it("shows before/after calendar context and every review field alongside a collapsed exact payload", () => {
    const preview = JSON.stringify({
      command: { type: "browser.calendar.move", itemId: "event-1", expectedRevision: "revision-1", newDate: "2026-09-24", startTime: "14:00", endTime: "15:00", timeZone: "Europe/Paris" },
      review: { title: "Planning", accountEmail: "test@example.org", sourceId: "calendar-source", currentWhen: "23 September, 09:00–10:00", newDate: "2026-09-24", startTime: "14:00", endTime: "15:00", timeZone: "Europe/Paris", effect: "Guests may receive updates", recurring: false, attendees: ["team@example.org"], extraSafety: { enabled: true, note: "<b>literal</b>" } },
      unknownMetadata: "Preserve me",
    }, null, 2);
    const html = renderToStaticMarkup(<ActionPreview preview={preview}/>);
    for (const value of ["Before", "After", "Planning", "2026-09-24 · 14:00 · 15:00", "Europe/Paris", "Calendar and attendee effect", "Guests may receive updates", "team@example.org", "Recurring event", ">No<", "Extra Safety", "Preserve me", "&lt;b&gt;literal&lt;/b&gt;", "revision-1"]) expect(html).toContain(value);
    expect(html).toContain('<details class="chat-payload"><summary>Exact action payload</summary>');
    expect(html).not.toContain("<b>");
  });

  it("renders draft and task fields without interpreting their contents as Markdown or HTML", () => {
    const draft = renderToStaticMarkup(<ActionPreview preview={JSON.stringify({ type: "draft.create", to: ["recipient@example.org"], subject: "**Literal**", body: "<script>not code</script>\nTwo lines", cc: [], metadata: null })}/>);
    expect(draft).toContain("Draft · not sent");
    expect(draft).toContain("recipient@example.org");
    expect(draft).toContain("**Literal**");
    expect(draft).toContain("&lt;script&gt;not code&lt;/script&gt;\nTwo lines");
    expect(draft).toContain("Not set");
    const task = renderToStaticMarkup(<ActionPreview preview={JSON.stringify({ type: "task.create", title: "Review", priority: "high", dueAt: "2026-09-24", completed: false })}/>);
    for (const value of ["Task update", "Review", "Priority", "2026-09-24", ">No<"]) expect(task).toContain(value);
  });

  it("retains legacy non-JSON and non-object previews verbatim", () => {
    for (const preview of ["task.create\nTitle: <b>Review</b>", "[1,2]", "null", "bad{json"]) {
      const html = renderToStaticMarkup(<ActionPreview preview={preview}/>);
      expect(html).toContain("Exact action preview");
      expect(html).toContain(preview.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
  });
});

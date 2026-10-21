import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import "./email-body.css";

const tags = ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "hr", "a", "caption", "sup", "sub", "small", "center", "font"];
const styleProperties = ["color", "background-color", "font-size", "font-weight", "font-style", "font-family",
  "text-align", "text-decoration", "line-height", "border", "border-color", "border-width", "border-style",
  "border-collapse", "border-spacing", "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "vertical-align", "white-space",
  "width", "min-width", "max-width"];

function emailDocument(html: string): string {
  const fragment = DOMPurify.sanitize(html.slice(0, 1_000_000), {
    ALLOWED_TAGS: tags, ALLOWED_ATTR: ["style", "colspan", "rowspan", "align", "valign", "dir", "width", "cellpadding", "cellspacing", "color", "face", "size"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "svg", "math", "template"],
  });
  for (const node of fragment.querySelectorAll<HTMLElement>("[style]")) {
    const original = node.style;
    const safe = document.createElement("span").style;
    for (const property of styleProperties) {
      const value = original.getPropertyValue(property);
      // Even sandboxed mail must not issue requests or hide/overlay app controls.
      if (value && !/url|image|expression|var\(|attr\(|\\|@/i.test(value)) safe.setProperty(property, value);
    }
    node.removeAttribute("style");
    if (safe.cssText) node.setAttribute("style", safe.cssText);
  }
  const container = document.createElement("div");
  container.append(fragment);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light}body{margin:16px;color:#202d35;background:#fff;font:15px/1.6 Arial,sans-serif;overflow-wrap:anywhere}table{max-width:100%;border-collapse:collapse}td,th{padding:6px;vertical-align:top}pre{white-space:pre-wrap}blockquote{margin-left:12px;padding-left:14px;border-left:3px solid #cbd5df}a{color:#256b81;text-decoration:underline}h1,h2,h3{line-height:1.3}*{max-width:100%;box-sizing:border-box}</style></head><body>${container.innerHTML}</body></html>`;
}

const htmlCache = new Map<string, string>();
/** Loads formatted HTML left out of the window snapshot, without triggering a full snapshot refresh. */
function useOmittedHtml(messageId: string | undefined, revision: string | undefined): string | undefined {
  const key = messageId ? `${messageId}:${revision ?? ""}` : "";
  const [loaded, setLoaded] = useState<{ key: string; html?: string }>();
  useEffect(() => {
    if (!key || htmlCache.has(key) || typeof window === "undefined" || !window.relay) return;
    let active = true;
    window.relay.command({ type: "message.html", messageId: messageId! }).then(result => {
      if (result.html) {
        htmlCache.set(key, result.html);
        if (htmlCache.size > 60) htmlCache.delete(htmlCache.keys().next().value!);
      }
      if (active) setLoaded({ key, html: result.html });
    }, () => { if (active) setLoaded({ key }); });
    return () => { active = false; };
  }, [key, messageId]);
  if (!key) return undefined;
  return htmlCache.get(key) ?? (loaded?.key === key ? loaded.html : undefined);
}

export function EmailBody({ body, html, messageId, revision }: { body: string; html?: string; messageId?: string; revision?: string }) {
  const [plain, setPlain] = useState(false);
  const lazy = useOmittedHtml(html ? undefined : messageId, revision);
  const source = html ?? lazy;
  const content = useMemo(() => source ? emailDocument(source) : undefined, [source]);
  if (!content) return <div className="plain-body">{body}</div>;
  return <section className="email-body">
    <div className="email-body-toolbar"><span>Formatted email · remote images and active content blocked</span>
      <button className="quiet small" onClick={() => setPlain(value => !value)}>{plain ? "Formatted view" : "Plain text"}</button>
    </div>
    {plain ? <div className="plain-body">{body}</div> : <iframe title="Formatted email" sandbox="" referrerPolicy="no-referrer" srcDoc={content}/>}
  </section>;
}

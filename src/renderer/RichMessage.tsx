import { createContext, isValidElement, useContext, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

const allowedElements = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del",
  "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "input",
];
const plugins = [remarkGfm];
const CopyContext = createContext<(text: string) => Promise<boolean>>(async () => false);

export function safeMessageUrl(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password ? value : undefined;
  } catch { return undefined; }
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const copy = useContext(CopyContext);
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const code = isValidElement<{ children?: string; className?: string }>(children) ? children : undefined;
  const text = String(code?.props.children ?? "");
  const language = /(?:^|\s)language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1];
  const copyCode = async () => {
    if (state === "copying") return;
    setState("copying");
    try { setState(await copy(text) ? "copied" : "error"); }
    catch { setState("error"); }
  };
  return <div className="chat-code-block">
    <div className="chat-code-toolbar"><span>{language || "Code"}</span><button type="button" className="quiet small" disabled={state === "copying"} onClick={() => void copyCode()} aria-label="Copy code">
      {state === "copied" ? <Check size={13}/> : <Copy size={13}/>}Copy code
    </button><span className="chat-copy-status" role="status">{state === "copied" ? "Copied" : state === "error" ? "Could not copy" : ""}</span></div>
    <pre tabIndex={0} aria-label={language ? `${language} code` : "Code block"}>{children}</pre>
  </div>;
}

const components: Components = {
  a: ({ href, children }) => {
    const url = safeMessageUrl(href);
    return <span className={url ? "chat-safe-link" : undefined}>{children}{url && <span className="chat-link-address"> ({url})</span>}</span>;
  },
  pre: CodeBlock,
  table: ({ children }) => <div className="chat-table-scroll" role="region" aria-label="Response table" tabIndex={0}><table>{children}</table></div>,
  input: ({ checked }) => <span className="chat-task-marker" role="img" aria-label={checked ? "Checked" : "Unchecked"}>{checked ? "☑" : "☐"}</span>,
};

export function RichMessage({ text, copy }: { text: string; copy: (text: string) => Promise<boolean> }) {
  return <CopyContext.Provider value={copy}><div className="chat-rich-message"><Markdown
    remarkPlugins={plugins}
    skipHtml
    allowedElements={allowedElements}
    urlTransform={url => safeMessageUrl(url) ?? ""}
    components={components}
  >{text}</Markdown></div></CopyContext.Provider>;
}

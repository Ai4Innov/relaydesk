import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

describe.skipIf(!process.env.RELAY_UI_BROWSER_TEST)("formatted mail isolation", () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin: string;
  beforeAll(async () => {
    server = await createServer({ configFile: "vite.renderer.config.ts", optimizeDeps: { include: ["dompurify"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    origin = server.resolvedUrls!.local[0];
    browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER_CHANNEL || "msedge", headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
  it("renders email tables/styles without requests, script execution, links, forms or parent access", async () => {
    const page = await browser.newPage();
    const external: string[] = [];
    page.on("request", request => { if (request.url().includes("tracking.invalid")) external.push(request.url()); });
    await page.goto(origin);
    const input = `<h2 style="color:rgb(20, 60, 80);position:fixed">Monthly report</h2>
        <table width="600" style="width:600px"><tr><th>Team</th><th>Result</th></tr><tr><td>Design</td><td>Ready</td></tr></table>
        <center><font color="#123456">Legacy email layout</font></center>
        <script>parent.document.body.textContent='compromised'</script><style>@import 'https://tracking.invalid/style';</style>
        <img src="https://tracking.invalid/pixel" onerror="alert(1)"><a href="https://tracking.invalid/click">Reference</a>
        <div style="background-image:url(https://tracking.invalid/image);color:red">Safe text</div>
        <form action="https://tracking.invalid/post"><input autofocus></form><svg onload="alert(2)"></svg>
        <iframe src="https://tracking.invalid/frame"></iframe>`;
    const markup = await page.evaluate(`(async () => {
      const { emailDocument } = await import("/src/renderer/EmailBody.tsx");
      const html = emailDocument(${JSON.stringify(input)});
      const frame = document.createElement("iframe");
      frame.title = "Email isolation test";
      frame.setAttribute("sandbox", "");
      frame.srcdoc = html;
      document.body.append(frame);
      return html;
    })()`);
    const frame = page.frameLocator('iframe[title="Email isolation test"]');
    await browserExpect(frame.getByRole("heading", { name: "Monthly report" })).toBeVisible();
    await browserExpect(frame.getByRole("cell", { name: "Ready", exact: true })).toBeVisible();
    expect(markup).not.toMatch(/tracking\.invalid|position:|onerror|href=|<script|<img|<form|<svg|<iframe/);
    await browserExpect(frame.locator("h2")).toHaveCSS("color", "rgb(20, 60, 80)");
    await browserExpect(frame.locator("table")).toHaveAttribute("width", "600");
    await browserExpect(frame.locator("font")).toHaveCSS("color", "rgb(18, 52, 86)");
    expect(await page.locator('iframe[title="Email isolation test"]').evaluate((element: HTMLIFrameElement) => element.contentDocument === null)).toBe(true);
    expect(external).toEqual([]);
    await page.close();
  });
});

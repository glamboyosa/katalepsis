import path from "node:path";
import type { Browser, BrowserContext, Locator, Page, Request } from "playwright-core";
import type { AssertionRecord } from "./outcome.ts";

/** Roles the agent may target. Kept to ARIA roles the demo and common forms use. */
export const ROLES = [
  "alert",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "heading",
  "link",
  "listitem",
  "option",
  "radio",
  "status",
  "tab",
  "textbox",
] as const;
export type Role = (typeof ROLES)[number];

export type ActionRecord = {
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  readonly ok: boolean;
  readonly result: string;
  readonly at: string;
};

export type Target = {
  readonly role?: Role | undefined;
  readonly name?: string | undefined;
  readonly text?: string | undefined;
};

const ACTION_TIMEOUT_MS = 5_000;
const ASSERT_TIMEOUT_MS = 3_000;
const SNAPSHOT_LIMIT = 6_000;
const POLL_MS = 100;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const describeTarget = (target: Target): string => {
  if (target.role !== undefined) {
    const named = target.name === undefined ? `role "${target.role}"` : `role "${target.role}" named "${target.name}"`;
    if (target.text === undefined) return named;
    return target.name === undefined ? `${named} with text "${target.text}"` : `${named} containing "${target.text}"`;
  }
  return target.text === undefined ? "the page" : `text "${target.text}"`;
};

/**
 * True for a navigation of a page's main frame. A popup's first request has no frame yet,
 * and Playwright throws when asked for it; that is a new top-level page too.
 */
const isTopLevel = (request: Request): boolean => {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return true;
  }
};

const errorText = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

/**
 * One isolated browser context for one check. Every action and assertion is logged, every
 * assertion leaves a screenshot, and navigation outside the allowlist is refused and recorded.
 *
 * A second, untouched copy of the start page is kept so each "visible" assertion can also be
 * checked against the page as it was before the agent acted. That separates a result the
 * agent caused from text that was on the page all along.
 */
export class CheckSession {
  readonly actions: Array<ActionRecord> = [];
  readonly assertions: Array<AssertionRecord> = [];
  /** Screenshot paths keyed by assertion ID. */
  readonly screenshots = new Map<string, string>();
  /** Set when the page tried to leave the allowed origins. */
  navigationViolation: string | null = null;
  /** Untouched copies of every page the agent loaded by URL, starting with the start page. */
  private readonly baselinePages: Array<Page>;
  // Models may call several tools in one step. Browser actions on one page must not
  // interleave (two fills would type into whichever field has focus), so they run in order.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly baselineContext: BrowserContext,
    private readonly baselinePage: Page,
    private readonly baseUrl: URL,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly scratchDir: string,
  ) {
    this.baselinePages = [baselinePage];
  }

  static async open(
    browser: Browser,
    baseUrl: string,
    allowedOrigins: ReadonlyArray<string>,
    scratchDir: string,
  ): Promise<CheckSession> {
    // Copy buttons only confirm once the clipboard write succeeds, which headless Chromium
    // refuses without this permission, so a working button would otherwise look broken.
    const contextOptions = { permissions: ["clipboard-read", "clipboard-write"] };
    const context = await browser.newContext(contextOptions);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const baselineContext = await browser.newContext(contextOptions);
    const baselinePage = await baselineContext.newPage();
    const session = new CheckSession(
      context,
      page,
      baselineContext,
      baselinePage,
      new URL(baseUrl),
      new Set(allowedOrigins),
      scratchDir,
    );
    await session.guard(page);
    await baselineContext.route("**/*", async (route) => {
      const request = route.request();
      const blocked = request.isNavigationRequest() && !session.allowedOrigins.has(new URL(request.url()).origin);
      await (blocked ? route.abort("blockedbyclient") : route.fallback());
    });
    return session;
  }

  private violate(origin: string): void {
    this.navigationViolation ??= `The page tried to navigate to ${origin}, which is not in the allowlist.`;
  }

  /**
   * Blocks top-level navigation to other origins. The route catches direct requests; the
   * main-frame listener catches redirects, which routes only see for their first URL; popups
   * are closed because the tools only drive the main page.
   */
  private async guard(page: Page): Promise<void> {
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      const origin = new URL(request.url()).origin;
      if (request.isNavigationRequest() && isTopLevel(request) && !this.allowedOrigins.has(origin)) {
        this.violate(origin);
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      if (url.protocol.startsWith("http") && !this.allowedOrigins.has(url.origin)) this.violate(url.origin);
    });
    this.context.on("page", (popup) => {
      if (popup !== page) void popup.close().catch(() => undefined);
    });
  }

  /** Opens the start page, plus the untouched baseline copy. Returns an error message on failure. */
  async start(target: string): Promise<string | null> {
    const url = new URL(target, this.baseUrl);
    if (!this.allowedOrigins.has(url.origin)) return `The start page ${url.origin} is not in the allowlist.`;
    try {
      const [response] = await Promise.all([
        this.page.goto(url.href, { timeout: ACTION_TIMEOUT_MS * 3 }),
        this.baselinePage.goto(url.href, { timeout: ACTION_TIMEOUT_MS * 3 }),
      ]);
      this.log("start", { target }, true, `Loaded ${url.pathname} (HTTP ${response?.status() ?? "unknown"}).`);
      return null;
    } catch (error) {
      const message = `The start page did not load: ${errorText(error)}`;
      this.log("start", { target }, false, message);
      return message;
    }
  }

  private exclusive<A>(action: () => Promise<A>): Promise<A> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private log(tool: string, input: unknown, ok: boolean, result: string): string {
    this.actions.push({ step: this.actions.length + 1, tool, input, ok, result, at: new Date().toISOString() });
    return result;
  }

  /**
   * Actions match names and text loosely, like a person would. Assertions match exactly, so
   * a short word such as "email" cannot pass by matching a field label instead of a message.
   */
  private locate(target: Target, exact = false, page: Page = this.page): Locator {
    if (target.role !== undefined) {
      const byRole = page.getByRole(target.role, target.name === undefined ? {} : { name: target.name, exact });
      if (target.text === undefined) return byRole;
      const text = target.text;
      // Exact here means the whole phrase, not part of a word: a dialog can hold its message
      // beside buttons, and a list item its label beside a price. A RegExp skips Playwright's
      // whitespace normalisation, so any run of spaces, line breaks or NBSPs matches.
      const phrase = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(text.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`,
        "u",
      );
      const showsText = (locator: Locator): Locator => locator.filter({ hasText: exact ? phrase : text });
      if (target.name !== undefined) return showsText(byRole);
      // Models often give a role with its text and no name. Ignoring the text would match the
      // first element with that role. Buttons and headings take their name from their text,
      // but alerts and status messages do not, so the text matches either way.
      return page.getByRole(target.role, { name: text, exact }).or(showsText(page.getByRole(target.role)));
    }
    if (target.text !== undefined) return page.getByText(target.text, { exact });
    throw new Error("Give a role (optionally with a name) or a text to target.");
  }

  private async navigateNow(target: string): Promise<string> {
    const url = new URL(target, this.baseUrl);
    if (!this.allowedOrigins.has(url.origin)) {
      return this.log("navigate", { target }, false, `Refused: ${url.origin} is not in the allowlist.`);
    }
    try {
      const response = await this.page.goto(url.href, { timeout: ACTION_TIMEOUT_MS * 3 });
      // A page the agent opened by URL is not something it caused, so an untouched copy is
      // kept for it as well. Without that copy the evidence rule cannot be applied.
      const copy = await this.baselineContext.newPage();
      this.baselinePages.push(copy);
      await copy.goto(url.href, { timeout: ACTION_TIMEOUT_MS * 3 }).catch((error: unknown) => {
        this.navigationViolation ??= `Could not load an untouched copy of ${url.pathname}: ${errorText(error)}`;
      });
      return this.log(
        "navigate",
        { target },
        true,
        `Loaded ${url.pathname} (HTTP ${response?.status() ?? "unknown"}).`,
      );
    } catch (error) {
      return this.log("navigate", { target }, false, `Navigation failed: ${errorText(error)}`);
    }
  }

  private async snapshotNow(): Promise<string> {
    try {
      const tree = await this.page.locator("body").ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
      const text = tree.length > SNAPSHOT_LIMIT ? `${tree.slice(0, SNAPSHOT_LIMIT)}\n… (truncated)` : tree;
      this.log("snapshot", {}, true, `Accessibility snapshot, ${tree.length} characters.`);
      return text;
    } catch (error) {
      return this.log("snapshot", {}, false, `Snapshot failed: ${errorText(error)}`);
    }
  }

  private async clickNow(target: Target): Promise<string> {
    try {
      await this.locate(target).first().click({ timeout: ACTION_TIMEOUT_MS });
      return this.log("click", target, true, `Clicked ${describeTarget(target)}.`);
    } catch (error) {
      return this.log("click", target, false, `Could not click ${describeTarget(target)}: ${errorText(error)}`);
    }
  }

  private async fillNow(label: string, value: string): Promise<string> {
    const input = { label, value };
    try {
      const byLabel = this.page.getByLabel(label);
      const field = (await byLabel.count()) > 0 ? byLabel : this.page.getByRole("textbox", { name: label });
      await field.first().fill(value, { timeout: ACTION_TIMEOUT_MS });
      return this.log("fill", input, true, `Filled "${label}".`);
    } catch (error) {
      return this.log("fill", input, false, `Could not fill "${label}": ${errorText(error)}`);
    }
  }

  private async pressNow(key: string): Promise<string> {
    try {
      await this.page.keyboard.press(key);
      return this.log("press", { key }, true, `Pressed ${key}.`);
    } catch (error) {
      return this.log("press", { key }, false, `Could not press ${key}: ${errorText(error)}`);
    }
  }

  /** Polls until `condition` holds or the assertion timeout passes. */
  private async poll(condition: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + ASSERT_TIMEOUT_MS;
    for (;;) {
      if (await condition().catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async assertNow(
    expectation: "visible" | "hidden" | "url-includes",
    target: Target & { readonly value?: string | undefined },
  ): Promise<AssertionRecord> {
    const id = `a${this.assertions.length + 1}`;
    let description: string;
    let passed: boolean;
    let detail: string;
    let trueAtStart: boolean | null = null;
    try {
      if (expectation === "url-includes") {
        const value = target.value ?? "";
        description = `URL contains "${value}"`;
        passed = value !== "" && (await this.poll(async () => this.page.url().includes(value)));
        detail = `URL was ${new URL(this.page.url()).pathname}`;
      } else {
        const locator = this.locate(target, true);
        const visibleCount = async () => locator.filter({ visible: true }).count();
        description = `${describeTarget(target)} is ${expectation}`;
        passed = await this.poll(async () =>
          expectation === "visible" ? (await visibleCount()) > 0 : (await visibleCount()) === 0,
        );
        detail = `${await visibleCount()} visible match(es) after waiting up to ${ASSERT_TIMEOUT_MS / 1000}s`;
        if (expectation === "visible") {
          const counts = await Promise.all(
            this.baselinePages.map((copy) => this.locate(target, true, copy).filter({ visible: true }).count()),
          );
          trueAtStart = counts.some((count) => count > 0);
          if (trueAtStart) detail = `${detail}; also visible on an untouched copy of the page`;
        }
      }
    } catch (error) {
      description = `${describeTarget(target)} is ${expectation}`;
      passed = false;
      detail = `Assertion could not run: ${errorText(error)}`;
    }
    const record: AssertionRecord = { id, expectation, description, passed, detail, trueAtStart };
    this.assertions.push(record);
    const screenshot = path.join(this.scratchDir, `${id}.png`);
    await this.page.screenshot({ path: screenshot }).then(
      () => this.screenshots.set(id, screenshot),
      () => undefined,
    );
    this.log(
      "assert",
      { expectation, ...target },
      true,
      `${id}: ${description}: ${passed ? "PASSED" : "FAILED"} (${detail})`,
    );
    return record;
  }

  /** Resolves a path or URL against the preview and refuses origins outside the allowlist. */
  navigate(target: string): Promise<string> {
    return this.exclusive(() => this.navigateNow(target));
  }

  snapshot(): Promise<string> {
    return this.exclusive(() => this.snapshotNow());
  }

  click(target: Target): Promise<string> {
    return this.exclusive(() => this.clickNow(target));
  }

  fill(label: string, value: string): Promise<string> {
    return this.exclusive(() => this.fillNow(label, value));
  }

  press(key: string): Promise<string> {
    return this.exclusive(() => this.pressNow(key));
  }

  /**
   * Runs a browser assertion and records it with a screenshot. The model chooses what to
   * assert; whether it passed comes only from the page.
   */
  assert(
    expectation: "visible" | "hidden" | "url-includes",
    target: Target & { readonly value?: string | undefined },
  ): Promise<AssertionRecord> {
    return this.exclusive(() => this.assertNow(expectation, target));
  }

  /** Stops tracing into `traceFile` and closes both contexts. Safe to call more than once. */
  async close(traceFile: string): Promise<boolean> {
    await this.baselineContext.close().catch(() => undefined);
    try {
      await this.context.tracing.stop({ path: traceFile });
      await this.context.close();
      return true;
    } catch {
      await this.context.close().catch(() => undefined);
      return false;
    }
  }
}

import { Page } from 'playwright';

/**
 * Page actions for the self-hosted Playwright service.
 *
 * Mirrors the subset of Firecrawl's `actions` API that can be run with plain
 * Playwright: wait, scroll, click, write, press, scrape and executeJavascript.
 * screenshot and pdf are not supported here and are rejected up front so the
 * caller gets a clear error instead of a silently partial result.
 */

export type PageAction =
  | { type: 'wait'; milliseconds?: number; selector?: string }
  | { type: 'scroll'; direction?: 'up' | 'down'; selector?: string }
  | { type: 'click'; selector: string; all?: boolean }
  | { type: 'write'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scrape' }
  | { type: 'executeJavascript'; script: string };

export const SUPPORTED_ACTION_TYPES = new Set([
  'wait',
  'scroll',
  'click',
  'write',
  'press',
  'scrape',
  'executeJavascript',
]);

export interface ActionResults {
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
}

export class UnsupportedActionError extends Error {
  constructor(public actionType: string) {
    super(`Action type "${actionType}" is not supported by playwright-service`);
  }
}

export class ActionFailedError extends Error {
  constructor(
    public index: number,
    public actionType: string,
    cause: unknown,
  ) {
    super(
      `Action #${index} (${actionType}) failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export function validateActions(actions: unknown): PageAction[] {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) {
    throw new Error('"actions" must be an array');
  }
  for (const action of actions) {
    const type = action?.type;
    if (typeof type !== 'string' || !SUPPORTED_ACTION_TYPES.has(type)) {
      throw new UnsupportedActionError(String(type));
    }
  }
  return actions as PageAction[];
}

// Short settle after actions that can trigger network-loaded content
// (infinite scroll, "load more" buttons). Bounded so it never stalls a scrape.
async function settle(page: Page, timeout: number) {
  try {
    await page.waitForLoadState('networkidle', {
      timeout: Math.min(timeout, 3000),
    });
  } catch {
    // networkidle is best-effort; pages with long-polling never reach it.
  }
}

async function scrollOnce(page: Page, direction: 'up' | 'down', selector?: string) {
  if (selector) {
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    return;
  }
  await page.evaluate((dir: 'up' | 'down') => {
    const step = window.innerHeight;
    const el = document.scrollingElement || document.documentElement;
    if (dir === 'down') {
      // Jump to the bottom so infinite-scroll sentinels near the end fire.
      window.scrollTo(0, Math.max(el.scrollHeight, el.scrollTop + step));
    } else {
      window.scrollBy(0, -step);
    }
  }, direction);
}

export async function runActions(
  page: Page,
  actions: PageAction[],
  timeout: number,
): Promise<ActionResults> {
  const results: ActionResults = { scrapes: [], javascriptReturns: [] };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    console.log(`Action #${i}: ${action.type}`);
    try {
      switch (action.type) {
        case 'wait':
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout });
          } else {
            await page.waitForTimeout(action.milliseconds ?? 0);
          }
          break;

        case 'scroll':
          await scrollOnce(page, action.direction ?? 'down', action.selector);
          await settle(page, timeout);
          break;

        case 'click':
          if (action.all) {
            const loc = page.locator(action.selector);
            const n = await loc.count();
            for (let j = 0; j < n; j++) {
              await loc.nth(j).click({ timeout });
            }
          } else {
            await page.locator(action.selector).first().click({ timeout });
          }
          await settle(page, timeout);
          break;

        case 'write':
          await page.keyboard.type(action.text);
          break;

        case 'press':
          await page.keyboard.press(action.key);
          await settle(page, timeout);
          break;

        case 'scrape':
          results.scrapes.push({ url: page.url(), html: await page.content() });
          break;

        case 'executeJavascript': {
          const value = await page.evaluate((src: string) => {
            // Run as an async function body so `return` and `await` work.
            // Built from a string: TypeScript downlevels `async function`
            // literals, so their constructor would be plain Function.
            return new Function(`return (async () => {\n${src}\n})();`)();
          }, action.script);
          results.javascriptReturns.push({ type: typeof value, value });
          break;
        }
      }
    } catch (error) {
      throw new ActionFailedError(i, action.type, error);
    }
  }

  return results;
}

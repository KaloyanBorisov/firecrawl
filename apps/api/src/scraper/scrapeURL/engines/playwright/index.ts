import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { ActionError } from "../../error";

// Action types the self-hosted playwright-service can run. screenshot and pdf
// still need Fire Engine.
const PLAYWRIGHT_SUPPORTED_ACTIONS = new Set([
  "wait",
  "scroll",
  "click",
  "write",
  "press",
  "scrape",
  "executeJavascript",
]);

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const actions = meta.options.actions ?? [];
  const unsupported = actions.find(
    a => !PLAYWRIGHT_SUPPORTED_ACTIONS.has(a.type),
  );
  if (unsupported) {
    throw new ActionError(
      `UNSUPPORTED_ACTION_${unsupported.type.toUpperCase()}: the "${unsupported.type}" action requires Fire Engine; playwright supports ${[...PLAYWRIGHT_SUPPORTED_ACTIONS].join(", ")}`,
    );
  }

  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      ...(actions.length > 0 && { actions }),
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      // Optional: older playwright-service builds don't send it.
      url: z.string().optional(),
      actions: z
        .object({
          scrapes: z.array(z.object({ url: z.string(), html: z.string() })),
          javascriptReturns: z.array(
            z.object({ type: z.string(), value: z.unknown() }),
          ),
        })
        .optional(),
      actionError: z
        .object({
          index: z.number(),
          type: z.string(),
          message: z.string(),
        })
        .optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.actionError) {
    throw new ActionError(
      `PLAYWRIGHT_ACTION_FAILED: ${response.actionError.message}`,
    );
  }

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    // The landed URL reported by the service. Redirect threat and blocklist
    // re-checks compare it against the requested URL. Falls back to the
    // requested URL for older services or a non-http(s) value (about:blank).
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    ...(response.actions && {
      actions: {
        screenshots: [],
        scrapes: response.actions.scrapes,
        javascriptReturns: response.actions.javascriptReturns,
        pdfs: [],
      },
    }),

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  // Budget explicit waits, plus a few seconds per other action for the
  // post-action network settle (scroll/click/press wait up to 3s each).
  const actionTime = (meta.options.actions ?? []).reduce(
    (acc, a) =>
      acc + (a.type === "wait" ? (a.milliseconds ?? 1000) : 3000),
    0,
  );
  return (meta.options.waitFor ?? 0) + actionTime + 30000;
}

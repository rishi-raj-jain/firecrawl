import express, { NextFunction, Request, Response } from "express";
import { crawlController } from "../controllers/v1/crawl";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import { scrapeController } from "../../src/controllers/v1/scrape";
import { crawlStatusController } from "../controllers/v1/crawl-status";
import { mapController } from "../controllers/v1/map";
import { ErrorResponse, RequestWithACUC, RequestWithAuth, RequestWithMaybeAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authenticateUser } from "../controllers/auth";
import { createIdempotencyKey } from "../services/idempotency/create";
import { validateIdempotencyKey } from "../services/idempotency/validate";
import { checkTeamCredits } from "../services/billing/credit_billing";
import expressWs from "express-ws";
import { crawlStatusWSController } from "../controllers/v1/crawl-status-ws";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { crawlCancelController } from "../controllers/v1/crawl-cancel";
import { Logger } from "../lib/logger";
import { scrapeStatusController } from "../controllers/v1/scrape-status";
// import { crawlPreviewController } from "../../src/controllers/v1/crawlPreview";
// import { crawlJobStatusPreviewController } from "../../src/controllers/v1/status";
// import { searchController } from "../../src/controllers/v1/search";
// import { crawlCancelController } from "../../src/controllers/v1/crawl-cancel";
// import { keyAuthController } from "../../src/controllers/v1/keyAuth";
// import { livenessController } from "../controllers/v1/liveness";
// import { readinessController } from "../controllers/v1/readiness";

function checkCreditsMiddleware(minimum?: number): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        (async () => {
            if (!minimum && req.body) {
                minimum = (req.body as any)?.limit ?? 1;
            }
            const { success, remainingCredits, chunk } = await checkTeamCredits(req.acuc, req.auth.team_id, minimum ?? 1);
            if (chunk) {
                req.acuc = chunk;
            }
            if (!success) {
                Logger.error(`Insufficient credits: ${JSON.stringify({ team_id: req.auth.team_id, minimum, remainingCredits })}`);
                if (!res.headersSent) {
                    return res.status(402).json({ success: false, error: "Insufficient credits. For more credits, you can upgrade your plan at https://firecrawl.dev/pricing." });
                }
            }
            req.account = { remainingCredits };
            next();
        })()
            .catch(err => next(err));
    };
}

export function authMiddleware(rateLimiterMode: RateLimiterMode): (req: RequestWithMaybeAuth, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        (async () => {
            const auth = await authenticateUser(
                req,
                res,
                rateLimiterMode,
            );

            if (!auth.success) {
                if (!res.headersSent) {
                    return res.status(auth.status).json({ success: false, error: auth.error });
                } else {
                    return;
                }
            }

            const { team_id, plan, chunk } = auth;

            req.auth = { team_id, plan };
            req.acuc = chunk ?? undefined;
            if (chunk) {
                req.account = { remainingCredits: chunk.remaining_credits };
            }
            next();
        })()
            .catch(err => next(err));
    }
}

function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    (async () => {
        if (req.headers["x-idempotency-key"]) {
            const isIdempotencyValid = await validateIdempotencyKey(req);
            if (!isIdempotencyValid) {
                if (!res.headersSent) {
                    return res.status(409).json({ success: false, error: "Idempotency key already used" });
                }
            }
            createIdempotencyKey(req);
        }
        next();
    })()
        .catch(err => next(err));
}

function blocklistMiddleware(req: Request, res: Response, next: NextFunction) {
    if (typeof req.body.url === "string" && isUrlBlocked(req.body.url)) {
        if (!res.headersSent) {
            return res.status(403).json({ success: false, error: "URL is blocked. Firecrawl currently does not support social media scraping due to policy restrictions." });
        }
    }
    next();
}

function wrap(controller: (req: Request, res: Response) => Promise<any>): (req: Request, res: Response, next: NextFunction) => any {
    return (req, res, next) => {
        controller(req, res)
            .catch(err => next(err))
    }
}

expressWs(express());

export const v1Router = express.Router();

v1Router.post(
    "/scrape",
    authMiddleware(RateLimiterMode.Scrape),
    checkCreditsMiddleware(1),
    blocklistMiddleware,
    wrap(scrapeController)
);

v1Router.post(
    "/crawl",
    authMiddleware(RateLimiterMode.Crawl),
    checkCreditsMiddleware(),
    blocklistMiddleware,
    idempotencyMiddleware,
    wrap(crawlController)
);

v1Router.post(
    "/map",
    authMiddleware(RateLimiterMode.Map),
    checkCreditsMiddleware(1),
    blocklistMiddleware,
    wrap(mapController)
);

v1Router.get(
    "/crawl/:jobId",
    authMiddleware(RateLimiterMode.CrawlStatus),
    wrap(crawlStatusController)
);

v1Router.get(
    "/scrape/:jobId",
    wrap(scrapeStatusController)
);

v1Router.ws(
    "/crawl/:jobId",
    crawlStatusWSController
);

// v1Router.post("/crawlWebsitePreview", crawlPreviewController);


v1Router.delete(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  crawlCancelController
);
// v1Router.get("/checkJobStatus/:jobId", crawlJobStatusPreviewController);

// // Auth route for key based authentication
// v1Router.get("/keyAuth", keyAuthController);

// // Search routes
// v0Router.post("/search", searchController);

// Health/Probe routes
// v1Router.get("/health/liveness", livenessController);
// v1Router.get("/health/readiness", readinessController);

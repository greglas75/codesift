import type { CodeIndex } from "../../types.js";
import { findAstroHandlers } from "../astro-routes.js";
import { findDjangoHandlers } from "./django.js";
import { findExpressHandlers } from "./express.js";
import { findHonoHandlers } from "./hono.js";
import { findKtorHandlers } from "./ktor.js";
import { findLaravelHandlers } from "./laravel.js";
import { findNestJSHandlers } from "./nest.js";
import { findNextJSHandlers, findPagesRouterHandlers } from "./next.js";
import { findFastAPIHandlers, findFlaskHandlers } from "./python-decorators.js";
import { findSpringBootKotlinHandlers } from "./spring-kotlin.js";
import type { RouteHandler } from "./types.js";
import { findYii2Handlers } from "./yii2.js";

export async function collectRouteHandlers(
  repo: string,
  index: CodeIndex,
  path: string,
): Promise<RouteHandler[]> {
  const [nest, hono, yii2, laravel, ktor, springKotlin, django] = await Promise.all([
    findNestJSHandlers(index, path),
    findHonoHandlers(repo, index, path),
    findYii2Handlers(index, path),
    findLaravelHandlers(index, path),
    findKtorHandlers(index, path),
    findSpringBootKotlinHandlers(index, path),
    findDjangoHandlers(index, path),
  ]);

  return [
    ...nest,
    ...findNextJSHandlers(index, path),
    ...findPagesRouterHandlers(index, path),
    ...findExpressHandlers(index, path),
    ...hono,
    ...yii2,
    ...laravel,
    ...ktor,
    ...springKotlin,
    ...findAstroHandlers(index, path),
    ...findFastAPIHandlers(index, path),
    ...findFlaskHandlers(index, path),
    ...django,
  ];
}


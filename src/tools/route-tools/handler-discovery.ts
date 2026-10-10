import { findAstroHandlers, isAstroPageFile } from "../astro-routes.js";
import { findDjangoHandlers } from "./django.js";
import { findExpressHandlers } from "./express.js";
import { findHonoHandlers } from "./hono.js";
import { findKtorHandlers } from "./ktor.js";
import { findLaravelHandlers } from "./laravel.js";
import { findNestJSHandlers } from "./nest.js";
import { findNextJSHandlers, findPagesRouterHandlers } from "./next.js";
import { findFastAPIHandlers, findFlaskHandlers } from "./python-decorators.js";
import { asRouteIndex, type RouteIndexInput } from "./route-index.js";
import { findSpringBootKotlinHandlers } from "./spring-kotlin.js";
import type { RouteHandler } from "./types.js";
import { findYii2Handlers } from "./yii2.js";

export async function collectRouteHandlers(
  repo: string,
  input: RouteIndexInput,
  path: string,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  // Astro reads only the page files' symbols — one read for all of them.
  const astroPages = index.files.filter((file) => isAstroPageFile(file.path)).map((file) => file.path);
  const astroIndex = {
    files: index.files,
    symbols: astroPages.length > 0 ? await index.inFiles(astroPages, false) : [],
  };

  const [nest, hono, yii2, laravel, ktor, springKotlin, django, next, pages, express, fastapi, flask] = await Promise.all([
    findNestJSHandlers(index, path),
    findHonoHandlers(repo, index, path),
    findYii2Handlers(index, path),
    findLaravelHandlers(index, path),
    findKtorHandlers(index, path),
    findSpringBootKotlinHandlers(index, path),
    findDjangoHandlers(index, path),
    findNextJSHandlers(index, path),
    findPagesRouterHandlers(index, path),
    findExpressHandlers(index, path),
    findFastAPIHandlers(index, path),
    findFlaskHandlers(index, path),
  ]);

  return [
    ...nest,
    ...next,
    ...pages,
    ...express,
    ...hono,
    ...yii2,
    ...laravel,
    ...ktor,
    ...springKotlin,
    ...findAstroHandlers(astroIndex, path),
    ...fastapi,
    ...flask,
    ...django,
  ];
}

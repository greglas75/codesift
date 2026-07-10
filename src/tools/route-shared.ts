/**
 * Match a URL path pattern against a concrete route path.
 * Handles :param, [param], [...param], [[...param]], <type:name>, and {name}.
 */
export function matchPath(routePath: string, searchPath: string): boolean {
  const normalize = (path: string) => path.replace(/^\/|\/$/g, "").toLowerCase();
  const routeParts = normalize(routePath).split("/");
  const searchParts = normalize(searchPath).split("/");

  if (routeParts.length !== searchParts.length) return false;
  for (let index = 0; index < routeParts.length; index++) {
    const routePart = routeParts[index];
    const searchPart = searchParts[index];
    if (routePart === undefined || searchPart === undefined) return false;
    if (routePart.startsWith(":") || routePart.startsWith("[") ||
        routePart.startsWith("<") || routePart.startsWith("{")) continue;
    if (routePart !== searchPart) return false;
  }
  return true;
}

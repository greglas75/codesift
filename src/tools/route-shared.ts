/**
 * Match a URL path pattern against a concrete route path.
 * Handles :param, [param], [...param], [[...param]], <type:name>, and {name}.
 */
export function matchPath(routePath: string, searchPath: string): boolean {
  const splitPath = (path: string) => {
    const normalized = path.replace(/^\/|\/$/g, "").toLowerCase();
    return normalized === "" ? [] : normalized.split("/");
  };
  const routeParts = splitPath(routePath);
  const searchParts = splitPath(searchPath);
  const catchAllIndex = routeParts.findIndex((part) =>
    /^\[\[?\.\.\.[^\]]+\]\]?$/.test(part),
  );

  if (catchAllIndex >= 0) {
    const optional = routeParts[catchAllIndex]!.startsWith("[[");
    if (catchAllIndex !== routeParts.length - 1) return false;
    if (searchParts.length < catchAllIndex + (optional ? 0 : 1)) return false;
    return routeParts.slice(0, catchAllIndex).every((part, index) =>
      segmentMatches(part, searchParts[index]),
    );
  }

  if (routeParts.length !== searchParts.length) return false;
  for (let index = 0; index < routeParts.length; index++) {
    if (!segmentMatches(routeParts[index], searchParts[index])) return false;
  }
  return true;
}

function segmentMatches(routePart?: string, searchPart?: string): boolean {
  if (routePart === undefined || searchPart === undefined) return false;
  if (routePart.startsWith(":") || routePart.startsWith("[") ||
      routePart.startsWith("<") || routePart.startsWith("{")) return true;
  return routePart === searchPart;
}

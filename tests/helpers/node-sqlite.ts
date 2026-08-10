const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
  .split(".")
  .map((part) => Number(part));

/** `node:sqlite` was added in Node 22.5. */
export const HAS_NODE_SQLITE =
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);

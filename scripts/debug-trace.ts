import { indexFolder } from "../src/tools/index-tools.js";
import { searchText } from "../src/tools/search-tools.js";

const res = await indexFolder("/Users/greglas/DEV/zyczeniakartki", { watch: false });
console.log("repo:", res.repo);

const t0 = Date.now();
const matches = await searchText(res.repo, "#__contact_details", {
  regex: false,
  max_results: 10,
});
console.log("matches:", matches.length, "time:", Date.now() - t0, "ms");
for (const m of matches.slice(0, 5)) {
  console.log(" ", m.file + ":" + m.line, (m.content ?? "").slice(0, 80));
}

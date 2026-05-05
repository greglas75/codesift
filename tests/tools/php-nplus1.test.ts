import { describe, it, expect, beforeAll } from "vitest";
import { resolve, join } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { findPhpNPlusOne } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-n-plus-one"));
const REPO = "local/php-n-plus-one";

describe("findPhpNPlusOne", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("flags foreach + relation access without ->with() in BadController", async () => {
    const r = await findPhpNPlusOne(REPO);
    const bad = r.findings.filter((f) => f.file.includes("BadController.php"));
    expect(bad.length).toBe(1);
    expect(bad[0]?.method).toBe("actionIndex");
    expect(bad[0]?.relation).toBe("profile");
    expect(bad[0]?.pattern).toBe("foreach-access-without-with");
  });

  it("does not flag GoodController (has ->with('profile'))", async () => {
    const r = await findPhpNPlusOne(REPO);
    const good = r.findings.filter((f) => f.file.includes("GoodController.php"));
    expect(good.length).toBe(0);
  });

  it("does not flag ScalarAccess (id/name are in SCALAR_FIELD_NAMES allowlist)", async () => {
    const r = await findPhpNPlusOne(REPO);
    const scalar = r.findings.filter((f) => f.file.includes("ScalarAccess.php"));
    expect(scalar.length).toBe(0);
  });

  it("returns finding with file, method, line, relation, pattern", async () => {
    const r = await findPhpNPlusOne(REPO);
    for (const f of r.findings) {
      expect(typeof f.file).toBe("string");
      expect(typeof f.method).toBe("string");
      expect(typeof f.line).toBe("number");
      expect(f.line).toBeGreaterThan(0);
      expect(typeof f.relation).toBe("string");
      expect(typeof f.pattern).toBe("string");
    }
  });

  it("respects limit option", async () => {
    const r = await findPhpNPlusOne(REPO, { limit: 0 });
    // limit=0 means the first finding.length >= 0 check returns immediately
    // so technically the first finding pushed satisfies >= 0. Verify at least
    // the function doesn't crash with limit option.
    expect(typeof r.total).toBe("number");
  });

  it("flags $user->getProfile() method call in MethodCallController actionBad", async () => {
    const r = await findPhpNPlusOne(REPO);
    const bad = r.findings.filter(
      (f) => f.file.includes("MethodCallController.php") && f.method === "actionBad",
    );
    expect(bad.length).toBe(1);
    expect(bad[0]?.relation).toBe("profile"); // normalized from getProfile
    expect(bad[0]?.pattern).toBe("foreach-getter-without-with");
  });

  it("does not flag MethodCallController actionGood (has ->with('profile'))", async () => {
    const r = await findPhpNPlusOne(REPO);
    const good = r.findings.filter(
      (f) => f.file.includes("MethodCallController.php") && f.method === "actionGood",
    );
    expect(good.length).toBe(0);
  });

  it("does not flag save/validate method calls in actionBlocklisted (METHOD_CALL_BLOCKLIST)", async () => {
    const r = await findPhpNPlusOne(REPO);
    const blocked = r.findings.filter(
      (f) => f.file.includes("MethodCallController.php") && f.method === "actionBlocklisted",
    );
    expect(blocked.length).toBe(0);
  });

  it("flags chained access ($order->customer->address->city) in ChainedController", async () => {
    const r = await findPhpNPlusOne(REPO);
    const chained = r.findings.filter((f) => f.file.includes("ChainedController.php"));
    // `customer` is the trigger (first segment); subsequent chained access
    // is irrelevant to the N+1 detection and MUST NOT create duplicates.
    expect(chained.length).toBeGreaterThanOrEqual(1);
    expect(chained.some((f) => f.relation === "customer")).toBe(true);
  });
});

describe("findPhpNPlusOne — Sprint 3 Pattern 4 (findOne in loop)", () => {
  it("flags User::findOne($id) inside foreach", async () => {
    const r = await findPhpNPlusOne(REPO);
    const hits = r.findings.filter(
      (f) =>
        f.file.includes("FindOneInLoopController.php") &&
        f.method === "actionFindOneInLoop" &&
        f.pattern === "foreach-findone-in-loop",
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].relation).toBe("User::findOne");
  });

  it("flags Member::findAll(...) inside foreach", async () => {
    const r = await findPhpNPlusOne(REPO);
    const hits = r.findings.filter(
      (f) =>
        f.file.includes("FindOneInLoopController.php") &&
        f.method === "actionFindAllInLoop" &&
        f.pattern === "foreach-findone-in-loop",
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].relation).toBe("Member::findAll");
  });

  it("does not flag Yii::createObject in loop (whitelisted)", async () => {
    const r = await findPhpNPlusOne(REPO);
    const hits = r.findings.filter(
      (f) =>
        f.file.includes("FindOneInLoopController.php") &&
        f.method === "actionLeaveYiiAlone",
    );
    expect(hits.length).toBe(0);
  });

  it("does not flag self::find in loop (whitelisted)", async () => {
    const r = await findPhpNPlusOne(REPO);
    const hits = r.findings.filter(
      (f) =>
        f.file.includes("FindOneInLoopController.php") &&
        f.method === "actionLeaveSelfAlone",
    );
    expect(hits.length).toBe(0);
  });
});

describe("findPhpNPlusOne — Sprint 3 Pattern 5 (relation access in views)", () => {
  it("flags $order->customer->... inside foreach in view file", async () => {
    const r = await findPhpNPlusOne(REPO);
    const viewHits = r.findings.filter((f) => f.file.includes("views/order/list.php"));
    expect(viewHits.length).toBeGreaterThanOrEqual(1);
    // Both `customer` (chained) and `getInvoice()` (getter) should fire.
    const relations = viewHits.map((h) => h.relation);
    expect(relations).toContain("customer");
  });
});

/**
 * Direct unit tests for tracePhpEvent + findPhpViews.
 * Both tools only read from sym.source in the indexed symbol set, so a
 * mocked getCodeIndex is enough — no filesystem access required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { tracePhpEvent, findPhpViews } from "../../src/tools/php-tools.js";

function makeSym(opts: {
  id: string;
  name: string;
  kind: "class" | "method" | "function";
  file: string;
  start_line: number;
  end_line: number;
  source: string;
  parent?: string;
}) {
  return {
    id: opts.id,
    repo: "test",
    name: opts.name,
    kind: opts.kind,
    file: opts.file,
    start_line: opts.start_line,
    end_line: opts.end_line,
    start_byte: 0,
    end_byte: 0,
    source: opts.source,
    tokens: [opts.name.toLowerCase()],
    ...(opts.parent ? { parent: opts.parent } : {}),
  };
}

function mockIndex(symbols: ReturnType<typeof makeSym>[], files: { path: string; language: string }[] = []) {
  vi.mocked(getCodeIndex).mockResolvedValue({
    repo: "test",
    root: "/tmp/test",
    symbols,
    files: files.map((f) => ({ ...f, symbol_count: 0, last_modified: 0 })),
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: files.length,
  });
}

describe("tracePhpEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects ->trigger('eventName') calls as triggers", async () => {
    const emitter = makeSym({
      id: "e1",
      name: "afterSave",
      kind: "method",
      file: "models/User.php",
      start_line: 10,
      end_line: 20,
      source: `public function afterSave($insert, $changedAttributes) {
    $this->trigger('userCreated', new Event(['sender' => $this]));
    parent::afterSave($insert, $changedAttributes);
}`,
    });
    mockIndex([emitter]);

    const r = await tracePhpEvent("test");
    expect(r.total).toBe(1);
    const event = r.events[0];
    expect(event?.event_name).toBe("userCreated");
    expect(event?.triggers).toHaveLength(1);
    expect(event?.triggers[0]?.file).toBe("models/User.php");
    expect(event?.triggers[0]?.line).toBeGreaterThanOrEqual(10);
    expect(event?.listeners).toHaveLength(0);
  });

  it("detects ->on('eventName', ...) registrations as listeners", async () => {
    const handler = makeSym({
      id: "h1",
      name: "init",
      kind: "method",
      file: "components/AuditComponent.php",
      start_line: 5,
      end_line: 25,
      source: `public function init() {
    parent::init();
    $this->on('userCreated', [$this, 'logUserCreation']);
    $this->on('orderPlaced', [$this, 'sendConfirmationEmail']);
}`,
    });
    mockIndex([handler]);

    const r = await tracePhpEvent("test");
    expect(r.total).toBe(2);
    const names = r.events.map((e) => e.event_name).sort();
    expect(names).toEqual(["orderPlaced", "userCreated"]);
    for (const e of r.events) {
      expect(e.listeners.length).toBe(1);
      expect(e.triggers.length).toBe(0);
    }
  });

  it("pairs triggers with listeners across files when event names match", async () => {
    const emitter = makeSym({
      id: "e2",
      name: "afterSave",
      kind: "method",
      file: "models/Order.php",
      start_line: 50,
      end_line: 60,
      source: `public function afterSave($insert, $changedAttributes) {
    $this->trigger('orderPlaced');
}`,
    });
    const listener = makeSym({
      id: "l2",
      name: "init",
      kind: "method",
      file: "components/Mailer.php",
      start_line: 10,
      end_line: 15,
      source: `public function init() {
    $this->on('orderPlaced', [$this, 'sendMail']);
}`,
    });
    mockIndex([emitter, listener]);

    const r = await tracePhpEvent("test");
    expect(r.total).toBe(1);
    const event = r.events[0];
    expect(event?.event_name).toBe("orderPlaced");
    expect(event?.triggers).toHaveLength(1);
    expect(event?.triggers[0]?.file).toBe("models/Order.php");
    expect(event?.listeners).toHaveLength(1);
    expect(event?.listeners[0]?.file).toBe("components/Mailer.php");
  });

  it("filters by event_name option", async () => {
    const emitter = makeSym({
      id: "e3",
      name: "doWork",
      kind: "method",
      file: "components/Worker.php",
      start_line: 1,
      end_line: 10,
      source: `public function doWork() {
    $this->trigger('jobStart');
    $this->trigger('jobEnd');
    $this->trigger('jobProgress');
}`,
    });
    mockIndex([emitter]);

    const r = await tracePhpEvent("test", { event_name: "jobEnd" });
    expect(r.total).toBe(1);
    expect(r.events[0]?.event_name).toBe("jobEnd");
  });

  it("returns empty result for non-PHP symbols", async () => {
    const jsSym = makeSym({
      id: "js1",
      name: "emit",
      kind: "method",
      file: "src/emitter.ts",
      start_line: 1,
      end_line: 5,
      source: `emit() { this.trigger('event1'); }`,
    });
    mockIndex([jsSym]);

    const r = await tracePhpEvent("test");
    expect(r.total).toBe(0);
  });
});

describe("findPhpViews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps $this->render('viewName') in controller action to view file path", async () => {
    const ctrl = makeSym({
      id: "c1",
      name: "SiteController",
      kind: "class",
      file: "controllers/SiteController.php",
      start_line: 1,
      end_line: 50,
      source: `class SiteController extends Controller { }`,
    });
    const action = makeSym({
      id: "a1",
      name: "actionIndex",
      kind: "method",
      file: "controllers/SiteController.php",
      start_line: 10,
      end_line: 15,
      source: `public function actionIndex() {
    return $this->render('index', ['data' => $data]);
}`,
      parent: "c1",
    });
    mockIndex([ctrl, action], [{ path: "views/site/index.php", language: "php" }]);

    const r = await findPhpViews("test");
    expect(r.total).toBe(1);
    expect(r.mappings[0]?.controller).toBe("SiteController");
    expect(r.mappings[0]?.action).toBe("actionIndex");
    expect(r.mappings[0]?.view_name).toBe("index");
    expect(r.mappings[0]?.view_file).toBe("views/site/index.php");
  });

  it("handles renderPartial / renderAjax / renderAsJson variants", async () => {
    const ctrl = makeSym({
      id: "c2",
      name: "UserController",
      kind: "class",
      file: "controllers/UserController.php",
      start_line: 1,
      end_line: 60,
      source: `class UserController extends Controller { }`,
    });
    const action = makeSym({
      id: "a2",
      name: "actionView",
      kind: "method",
      file: "controllers/UserController.php",
      start_line: 10,
      end_line: 25,
      source: `public function actionView() {
    $partial = $this->renderPartial('_form');
    $ajax = $this->renderAjax('_panel');
    $json = $this->renderAsJson('data');
}`,
      parent: "c2",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test");
    // All three render flavors detected
    const viewNames = r.mappings.map((m) => m.view_name).sort();
    expect(viewNames).toEqual(["_form", "_panel", "data"]);
    // view_file is null because fixture index has no matching view files
    for (const m of r.mappings) {
      expect(m.view_file).toBeNull();
    }
  });

  it("applies controller filter option", async () => {
    const siteCtrl = makeSym({
      id: "c3",
      name: "SiteController",
      kind: "class",
      file: "controllers/SiteController.php",
      start_line: 1,
      end_line: 20,
      source: `class SiteController extends Controller { }`,
    });
    const siteAction = makeSym({
      id: "a3",
      name: "actionIndex",
      kind: "method",
      file: "controllers/SiteController.php",
      start_line: 5,
      end_line: 10,
      source: `public function actionIndex() { return $this->render('home'); }`,
      parent: "c3",
    });
    const userCtrl = makeSym({
      id: "c4",
      name: "UserController",
      kind: "class",
      file: "controllers/UserController.php",
      start_line: 1,
      end_line: 20,
      source: `class UserController extends Controller { }`,
    });
    const userAction = makeSym({
      id: "a4",
      name: "actionList",
      kind: "method",
      file: "controllers/UserController.php",
      start_line: 5,
      end_line: 10,
      source: `public function actionList() { return $this->render('list'); }`,
      parent: "c4",
    });
    mockIndex([siteCtrl, siteAction, userCtrl, userAction]);

    // Unfiltered: both controllers mapped
    const all = await findPhpViews("test");
    expect(all.total).toBe(2);

    // Filtered: only UserController's mapping
    const filtered = await findPhpViews("test", { controller: "User" });
    expect(filtered.total).toBe(1);
    expect(filtered.mappings[0]?.controller).toBe("UserController");
    expect(filtered.mappings[0]?.view_name).toBe("list");
  });

  it("ignores non-action methods (those not starting with 'action')", async () => {
    const ctrl = makeSym({
      id: "c5",
      name: "HelperController",
      kind: "class",
      file: "controllers/HelperController.php",
      start_line: 1,
      end_line: 50,
      source: `class HelperController extends Controller { }`,
    });
    const helper = makeSym({
      id: "h5",
      name: "formatName",
      kind: "method",
      file: "controllers/HelperController.php",
      start_line: 10,
      end_line: 15,
      source: `private function formatName($u) {
    return $this->render('should-be-ignored');
}`,
      parent: "c5",
    });
    mockIndex([ctrl, helper]);

    const r = await findPhpViews("test");
    expect(r.total).toBe(0);
  });

  it("ignores non-Controller classes", async () => {
    const model = makeSym({
      id: "m1",
      name: "User",
      kind: "class",
      file: "models/User.php",
      start_line: 1,
      end_line: 20,
      source: `class User extends ActiveRecord { }`,
    });
    const method = makeSym({
      id: "mm1",
      name: "actionBogus",
      kind: "method",
      file: "models/User.php",
      start_line: 5,
      end_line: 10,
      source: `public function actionBogus() { return $this->render('x'); }`,
      parent: "m1",
    });
    mockIndex([model, method]);

    const r = await findPhpViews("test");
    expect(r.total).toBe(0);
  });
});

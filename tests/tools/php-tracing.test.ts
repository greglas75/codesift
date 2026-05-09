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
  kind: "class" | "method" | "function" | "constant";
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

describe("tracePhpEvent — Sprint 3 class const resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves Class::CONST_NAME to its string literal value in trigger()", async () => {
    const userClass = makeSym({
      id: "uc",
      name: "User",
      kind: "class",
      file: "models/User.php",
      start_line: 1,
      end_line: 50,
      source: `class User extends ActiveRecord { const EVENT_AFTER_LOGIN = 'afterLogin'; }`,
    });
    const constSym = makeSym({
      id: "uc-const",
      name: "EVENT_AFTER_LOGIN",
      kind: "constant",
      file: "models/User.php",
      start_line: 2,
      end_line: 2,
      source: `const EVENT_AFTER_LOGIN = 'afterLogin'`,
      parent: "uc",
    });
    const emitter = makeSym({
      id: "em",
      name: "login",
      kind: "method",
      file: "models/User.php",
      start_line: 10,
      end_line: 15,
      source: `public function login() { $this->trigger(User::EVENT_AFTER_LOGIN); }`,
    });
    mockIndex([userClass, constSym, emitter]);

    const r = await tracePhpEvent("test");
    // The const value 'afterLogin' should be the resolved event name in the
    // chain, not the raw "User::EVENT_AFTER_LOGIN" string.
    const chain = r.events.find((e) => e.event_name === "afterLogin");
    expect(chain).toBeDefined();
    expect(chain!.triggers.length).toBe(1);
  });

  it("resolves Class::CONST_NAME in Event::on(SomeClass::class, SomeClass::EVENT, ...)", async () => {
    const userClass = makeSym({
      id: "uc2",
      name: "User",
      kind: "class",
      file: "models/User.php",
      start_line: 1,
      end_line: 50,
      source: `class User extends ActiveRecord { const EVENT_AFTER_INSERT = 'afterInsert'; }`,
    });
    const constSym = makeSym({
      id: "uc2-const",
      name: "EVENT_AFTER_INSERT",
      kind: "constant",
      file: "models/User.php",
      start_line: 2,
      end_line: 2,
      source: `const EVENT_AFTER_INSERT = 'afterInsert'`,
      parent: "uc2",
    });
    const bootstrap = makeSym({
      id: "boot",
      name: "bootstrap",
      kind: "method",
      file: "components/Bootstrap.php",
      start_line: 5,
      end_line: 12,
      source: `public function bootstrap() {
        Event::on(User::class, User::EVENT_AFTER_INSERT, [SomeListener::class, 'handle']);
      }`,
    });
    mockIndex([userClass, constSym, bootstrap]);

    const r = await tracePhpEvent("test");
    const chain = r.events.find((e) => e.event_name === "afterInsert");
    expect(chain).toBeDefined();
    expect(chain!.listeners.length).toBe(1);
  });

  it("falls back to raw Class::CONST when constant cannot be resolved (vendor const)", async () => {
    // No class symbol in the index — simulating a const defined in vendor/.
    const emitter = makeSym({
      id: "em3",
      name: "login",
      kind: "method",
      file: "models/User.php",
      start_line: 10,
      end_line: 15,
      source: `public function login() { $this->trigger(Vendor::EXTERNAL_EVENT); }`,
    });
    mockIndex([emitter]);

    const r = await tracePhpEvent("test");
    // Should NOT silently drop the trigger — surface it under the unresolved key.
    const chain = r.events.find((e) => e.event_name === "Vendor::EXTERNAL_EVENT");
    expect(chain).toBeDefined();
    expect(chain!.triggers.length).toBe(1);
  });
});

describe("findPhpViews — Sprint 8 extensions (kind, layout, widgets, asset bundles, aliases)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures render kind for Partial / Ajax / AsJson / File flavors", async () => {
    const ctrl = makeSym({
      id: "ctrl-rk",
      name: "RKController",
      kind: "class",
      file: "controllers/RKController.php",
      start_line: 1,
      end_line: 60,
      source: `class RKController extends Controller { }`,
    });
    const action = makeSym({
      id: "act-rk",
      name: "actionMixed",
      kind: "method",
      file: "controllers/RKController.php",
      start_line: 10,
      end_line: 20,
      source: `public function actionMixed() {
        $a = $this->render('full-view');
        $b = $this->renderPartial('_partial');
        $c = $this->renderAjax('_panel');
        $d = $this->renderAsJson('payload-template');
        $e = $this->renderFile('@app/views/raw.php');
      }`,
      parent: "ctrl-rk",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test");
    const kinds = r.mappings.map((m) => m.render_kind).sort();
    // 'json' captures the AsJson form regardless of arg shape
    expect(kinds).toContain("full");
    expect(kinds).toContain("partial");
    expect(kinds).toContain("ajax");
    expect(kinds).toContain("json");
    expect(kinds).toContain("file");
  });

  it("captures path_alias when render uses @alias prefix", async () => {
    const ctrl = makeSym({
      id: "ctrl-al",
      name: "AliasController",
      kind: "class",
      file: "controllers/AliasController.php",
      start_line: 1,
      end_line: 30,
      source: `class AliasController extends Controller { }`,
    });
    const action = makeSym({
      id: "act-al",
      name: "actionShared",
      kind: "method",
      file: "controllers/AliasController.php",
      start_line: 5,
      end_line: 8,
      source: `public function actionShared() { return $this->render('@app/views/shared/banner'); }`,
      parent: "ctrl-al",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test");
    expect(r.mappings).toHaveLength(1);
    expect(r.mappings[0]!.path_alias).toBe("@app");
  });

  it("captures controller-wide $layout property and per-action override", async () => {
    const ctrl = makeSym({
      id: "ctrl-lay",
      name: "AdminController",
      kind: "class",
      file: "controllers/AdminController.php",
      start_line: 1,
      end_line: 30,
      source: `class AdminController extends Controller {
        public $layout = 'admin';
        public function actionSettings() {
          $this->layout = '@app/views/layouts/wide';
          return $this->render('settings');
        }
      }`,
    });
    const action = makeSym({
      id: "act-lay",
      name: "actionSettings",
      kind: "method",
      file: "controllers/AdminController.php",
      start_line: 4,
      end_line: 7,
      source: `public function actionSettings() {
          $this->layout = '@app/views/layouts/wide';
          return $this->render('settings');
        }`,
      parent: "ctrl-lay",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test");
    expect(r.layouts).toHaveLength(2);
    const propLayout = r.layouts.find((l) => l.action === null);
    const actionLayout = r.layouts.find((l) => l.action === "actionSettings");
    expect(propLayout!.layout).toBe("admin");
    expect(actionLayout!.layout).toBe("@app/views/layouts/wide");
  });

  it("collects widget references with caller class + method", async () => {
    const ctrl = makeSym({
      id: "ctrl-w",
      name: "PostController",
      kind: "class",
      file: "controllers/PostController.php",
      start_line: 1,
      end_line: 30,
      source: `class PostController extends Controller { }`,
    });
    const action = makeSym({
      id: "act-w",
      name: "actionList",
      kind: "method",
      file: "controllers/PostController.php",
      start_line: 5,
      end_line: 10,
      source: `public function actionList() {
        $form = ActiveForm::begin();
        echo GridView::widget(['dataProvider' => $dp]);
        ActiveForm::end();
      }`,
      parent: "ctrl-w",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test");
    expect(r.widgets.length).toBeGreaterThanOrEqual(2);
    const af = r.widgets.find((w) => w.widget === "ActiveForm" && w.kind === "begin");
    const gv = r.widgets.find((w) => w.widget === "GridView" && w.kind === "widget");
    expect(af).toBeDefined();
    expect(gv).toBeDefined();
    expect(af!.caller_class).toBe("PostController");
    expect(af!.caller_method).toBe("actionList");
  });

  it("collects AssetBundle::register() call sites", async () => {
    const view = makeSym({
      id: "view-fn",
      name: "_renderTopOfFile",
      kind: "function",
      file: "views/site/index.php",
      start_line: 1,
      end_line: 5,
      source: `<?php
        AppAsset::register($this);
        AdminAsset::register($this);
      `,
    });
    mockIndex([view]);

    const r = await findPhpViews("test");
    expect(r.asset_bundles.length).toBe(2);
    expect(r.asset_bundles.map((a) => a.bundle).sort()).toEqual([
      "AdminAsset",
      "AppAsset",
    ]);
  });

  it("respects include_widgets=false / include_asset_bundles=false flags", async () => {
    const ctrl = makeSym({
      id: "ctrl-skip",
      name: "SkipController",
      kind: "class",
      file: "controllers/SkipController.php",
      start_line: 1,
      end_line: 20,
      source: `class SkipController extends Controller { }`,
    });
    const action = makeSym({
      id: "act-skip",
      name: "actionFoo",
      kind: "method",
      file: "controllers/SkipController.php",
      start_line: 5,
      end_line: 10,
      source: `public function actionFoo() {
        ActiveForm::begin();
        AppAsset::register($this);
      }`,
      parent: "ctrl-skip",
    });
    mockIndex([ctrl, action]);

    const r = await findPhpViews("test", {
      include_widgets: false,
      include_asset_bundles: false,
    });
    expect(r.widgets).toHaveLength(0);
    expect(r.asset_bundles).toHaveLength(0);
  });
});

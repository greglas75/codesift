import { extractYii2Conventions, extractPhpConventions } from "../../src/tools/project-tools.js";

describe("extractYii2Conventions", () => {
  const mockFiles = [
    // Controllers
    { path: "controllers/SiteController.php" },
    { path: "controllers/UserController.php" },
    { path: "modules/admin/controllers/DashboardController.php" },
    // Models
    { path: "models/User.php" },
    { path: "models/Profile.php" },
    // Modules
    { path: "modules/admin/Module.php" },
    { path: "modules/api/Module.php" },
    // Widgets
    { path: "widgets/NavWidget.php" },
    { path: "widgets/SidebarWidget.php" },
    // Behaviors
    { path: "behaviors/TimestampBehavior.php" },
    { path: "components/behaviors/SoftDeleteBehavior.php" },
    // Components
    { path: "components/AuthManager.php" },
    { path: "components/Mailer.php" },
    // Assets
    { path: "assets/AppAsset.php" },
    { path: "assets/AdminAsset.php" },
    // Config files
    { path: "config/web.php" },
    { path: "config/console.php" },
    { path: "config/db.php" },
    { path: "config/params.php" },
    // Migrations
    { path: "migrations/m200101_000000_create_user_table.php" },
    { path: "migrations/m200102_000000_create_profile_table.php" },
    // Routes
    { path: "config/routes.php" },
    // Middleware
    { path: "middleware/CorsMiddleware.php" },
    // Other PHP files
    { path: "views/site/index.php" },
    { path: "runtime/logs/app.log" },
  ];

  it("extracts base PHP conventions (controllers, models, middleware, routes, migrations)", () => {
    const result = extractYii2Conventions(mockFiles);

    expect(result.controllers).toHaveLength(3);
    expect(result.controllers.map(c => c.name)).toContain("SiteController");
    expect(result.controllers.map(c => c.name)).toContain("UserController");
    expect(result.controllers.map(c => c.name)).toContain("DashboardController");

    expect(result.models).toHaveLength(2);
    expect(result.models.map(m => m.name)).toContain("User");
    expect(result.models.map(m => m.name)).toContain("Profile");

    expect(result.middleware).toHaveLength(1);
    expect(result.migrations_count).toBe(2);
  });

  it("extracts Yii2-specific modules", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.modules).toHaveLength(2);
    expect(result.modules.map(m => m.name)).toContain("Module");
    expect(result.modules.some(m => m.path.includes("admin"))).toBe(true);
    expect(result.modules.some(m => m.path.includes("api"))).toBe(true);
  });

  it("extracts widgets", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.widgets).toHaveLength(2);
    expect(result.widgets.map(w => w.name)).toContain("NavWidget");
    expect(result.widgets.map(w => w.name)).toContain("SidebarWidget");
  });

  it("extracts behaviors", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.behaviors).toHaveLength(2);
    expect(result.behaviors.map(b => b.name)).toContain("TimestampBehavior");
    expect(result.behaviors.map(b => b.name)).toContain("SoftDeleteBehavior");
  });

  it("extracts components", () => {
    const result = extractYii2Conventions(mockFiles);
    // 3 files: AuthManager, Mailer, and SoftDeleteBehavior (in components/behaviors/)
    expect(result.components).toHaveLength(3);
    expect(result.components.map(c => c.name)).toContain("AuthManager");
    expect(result.components.map(c => c.name)).toContain("Mailer");
  });

  it("extracts assets", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.assets).toHaveLength(2);
    expect(result.assets.map(a => a.name)).toContain("AppAsset");
    expect(result.assets.map(a => a.name)).toContain("AdminAsset");
  });

  it("extracts config files", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.config_files).toHaveLength(4);
    expect(result.config_files).toContain("config/web.php");
    expect(result.config_files).toContain("config/console.php");
    expect(result.config_files).toContain("config/db.php");
    expect(result.config_files).toContain("config/params.php");
  });

  it("sets framework_type to yii2", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result.framework_type).toBe("yii2");
  });

  it("includes all PhpConventions base fields", () => {
    const result = extractYii2Conventions(mockFiles);
    expect(result).toHaveProperty("controllers");
    expect(result).toHaveProperty("middleware");
    expect(result).toHaveProperty("models");
    expect(result).toHaveProperty("routes_files");
    expect(result).toHaveProperty("migrations_count");
  });
});

describe("extractPhpConventions (base)", () => {
  it("works on minimal file list", () => {
    const result = extractPhpConventions([
      { path: "app/Http/Controllers/UserController.php" },
      { path: "app/Models/User.php" },
    ]);
    expect(result.controllers).toHaveLength(1);
    expect(result.models).toHaveLength(1);
  });

  it("returns empty for non-PHP project", () => {
    const result = extractPhpConventions([
      { path: "src/index.ts" },
      { path: "src/app.tsx" },
    ]);
    expect(result.controllers).toHaveLength(0);
    expect(result.models).toHaveLength(0);
    expect(result.migrations_count).toBe(0);
  });
});

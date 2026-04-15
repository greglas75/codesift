type AnyFunction = (...args: any[]) => any;

function memoizeModule<TModule>(loader: () => Promise<TModule>): () => Promise<TModule> {
  let cached: Promise<TModule> | undefined;
  return () => {
    cached ??= loader();
    return cached;
  };
}

function lazyExport<T extends AnyFunction>(
  load: () => Promise<Record<string, unknown>>,
  key: string,
): T {
  return ((...args: Parameters<T>) =>
    load().then((mod) => (mod[key] as T)(...args))) as T;
}

const loadIndexTools = memoizeModule(() => import("./tools/index-tools.js"));
const loadSearchTools = memoizeModule(() => import("./tools/search-tools.js"));
const loadOutlineTools = memoizeModule(() => import("./tools/outline-tools.js"));
const loadSymbolTools = memoizeModule(() => import("./tools/symbol-tools.js"));
const loadGraphTools = memoizeModule(() => import("./tools/graph-tools.js"));
const loadReactTools = memoizeModule(() => import("./tools/react-tools.js"));
const loadImpactTools = memoizeModule(() => import("./tools/impact-tools.js"));
const loadRouteTools = memoizeModule(() => import("./tools/route-tools.js"));
const loadCommunityTools = memoizeModule(() => import("./tools/community-tools.js"));
const loadContextTools = memoizeModule(() => import("./tools/context-tools.js"));
const loadDiffTools = memoizeModule(() => import("./tools/diff-tools.js"));
const loadGenerateTools = memoizeModule(() => import("./tools/generate-tools.js"));
const loadRetrievalTools = memoizeModule(() => import("./retrieval/codebase-retrieval.js"));
const loadComplexityTools = memoizeModule(() => import("./tools/complexity-tools.js"));
const loadCloneTools = memoizeModule(() => import("./tools/clone-tools.js"));
const loadHotspotTools = memoizeModule(() => import("./tools/hotspot-tools.js"));
const loadCrossRepoTools = memoizeModule(() => import("./tools/cross-repo-tools.js"));
const loadPatternTools = memoizeModule(() => import("./tools/pattern-tools.js"));
const loadReportTools = memoizeModule(() => import("./tools/report-tools.js"));
const loadLspTools = memoizeModule(() => import("./lsp/lsp-tools.js"));
const loadConversationTools = memoizeModule(() => import("./tools/conversation-tools.js"));
const loadSecretTools = memoizeModule(() => import("./tools/secret-tools.js"));
const loadPhpTools = memoizeModule(() => import("./tools/php-tools.js"));
const loadMemoryTools = memoizeModule(() => import("./tools/memory-tools.js"));
const loadCoordinatorTools = memoizeModule(() => import("./tools/coordinator-tools.js"));
const loadFrequencyTools = memoizeModule(() => import("./tools/frequency-tools.js"));
const loadKotlinTools = memoizeModule(() => import("./tools/kotlin-tools.js"));
const loadHiltTools = memoizeModule(() => import("./tools/hilt-tools.js"));
const loadComposeTools = memoizeModule(() => import("./tools/compose-tools.js"));
const loadRoomTools = memoizeModule(() => import("./tools/room-tools.js"));
const loadSerializationTools = memoizeModule(() => import("./tools/serialization-tools.js"));
const loadAstroIslandsTools = memoizeModule(() => import("./tools/astro-islands.js"));
const loadAstroRoutesTools = memoizeModule(() => import("./tools/astro-routes.js"));
const loadAstroActionsTools = memoizeModule(() => import("./tools/astro-actions.js"));
const loadAstroAuditTools = memoizeModule(() => import("./tools/astro-audit.js"));
const loadNextjsRouteTools = memoizeModule(() => import("./tools/nextjs-route-tools.js"));
const loadNextjsMetadataTools = memoizeModule(() => import("./tools/nextjs-metadata-tools.js"));
const loadFrameworkAuditTools = memoizeModule(() => import("./tools/nextjs-framework-audit-tools.js"));
const loadAstroConfigTools = memoizeModule(() => import("./tools/astro-config.js"));
const loadAstroContentCollectionsTools = memoizeModule(() => import("./tools/astro-content-collections.js"));
const loadProjectTools = memoizeModule(() => import("./tools/project-tools.js"));
const loadModelTools = memoizeModule(() => import("./tools/model-tools.js"));
const loadPytestTools = memoizeModule(() => import("./tools/pytest-tools.js"));
const loadWiringTools = memoizeModule(() => import("./tools/wiring-tools.js"));
const loadRuffTools = memoizeModule(() => import("./tools/ruff-tools.js"));
const loadPyprojectTools = memoizeModule(() => import("./tools/pyproject-tools.js"));
const loadPythonConstantsTools = memoizeModule(() => import("./tools/python-constants-tools.js"));
const loadDjangoViewSecurityTools = memoizeModule(() => import("./tools/django-view-security-tools.js"));
const loadPythonCallersTools = memoizeModule(() => import("./tools/python-callers.js"));
const loadTaintTools = memoizeModule(() => import("./tools/taint-tools.js"));
const loadDjangoSettingsTools = memoizeModule(() => import("./tools/django-settings.js"));
const loadTypecheckTools = memoizeModule(() => import("./tools/typecheck-tools.js"));
const loadPythonDepsTools = memoizeModule(() => import("./tools/python-deps-analyzer.js"));
const loadPythonAuditTools = memoizeModule(() => import("./tools/python-audit.js"));
const loadFastapiDependsTools = memoizeModule(() => import("./tools/fastapi-depends.js"));
const loadAsyncCorrectnessTools = memoizeModule(() => import("./tools/async-correctness.js"));
const loadPydanticTools = memoizeModule(() => import("./tools/pydantic-models.js"));
const loadReviewDiffTools = memoizeModule(() => import("./tools/review-diff-tools.js"));
const loadAuditTools = memoizeModule(() => import("./tools/audit-tools.js"));
const loadStatusTools = memoizeModule(() => import("./tools/status-tools.js"));
const loadAgentConfigTools = memoizeModule(() => import("./tools/agent-config-tools.js"));
const loadTestImpactTools = memoizeModule(() => import("./tools/test-impact-tools.js"));
const loadDependencyAuditTools = memoizeModule(() => import("./tools/dependency-audit-tools.js"));
const loadMigrationLintTools = memoizeModule(() => import("./tools/migration-lint-tools.js"));
const loadPlanTurnTools = memoizeModule(() => import("./tools/plan-turn-tools.js"));
const loadAstroMigrationTools = memoizeModule(() => import("./tools/astro-migration.js"));
const loadPrismaSchemaTools = memoizeModule(() => import("./tools/prisma-schema-tools.js"));
const loadPerfTools = memoizeModule(() => import("./tools/perf-tools.js"));
const loadCouplingTools = memoizeModule(() => import("./tools/coupling-tools.js"));
const loadArchitectureTools = memoizeModule(() => import("./tools/architecture-tools.js"));
const loadNestTools = memoizeModule(() => import("./tools/nest-tools.js"));
const loadQueryTools = memoizeModule(() => import("./tools/query-tools.js"));
const loadWikiTools = memoizeModule(() => import("./tools/wiki-tools.js"));

export const indexFolder = lazyExport<typeof import("./tools/index-tools.js").indexFolder>(loadIndexTools, "indexFolder");
export const indexFile = lazyExport<typeof import("./tools/index-tools.js").indexFile>(loadIndexTools, "indexFile");
export const indexRepo = lazyExport<typeof import("./tools/index-tools.js").indexRepo>(loadIndexTools, "indexRepo");
export const listAllRepos = lazyExport<typeof import("./tools/index-tools.js").listAllRepos>(loadIndexTools, "listAllRepos");
export const invalidateCache = lazyExport<typeof import("./tools/index-tools.js").invalidateCache>(loadIndexTools, "invalidateCache");
export const getCodeIndex = lazyExport<typeof import("./tools/index-tools.js").getCodeIndex>(loadIndexTools, "getCodeIndex");

export const searchSymbols = lazyExport<typeof import("./tools/search-tools.js").searchSymbols>(loadSearchTools, "searchSymbols");
export const searchText = lazyExport<typeof import("./tools/search-tools.js").searchText>(loadSearchTools, "searchText");
export const semanticSearch = lazyExport<typeof import("./tools/search-tools.js").semanticSearch>(loadSearchTools, "semanticSearch");

export const getFileTree = lazyExport<typeof import("./tools/outline-tools.js").getFileTree>(loadOutlineTools, "getFileTree");
export const getFileOutline = lazyExport<typeof import("./tools/outline-tools.js").getFileOutline>(loadOutlineTools, "getFileOutline");
export const getRepoOutline = lazyExport<typeof import("./tools/outline-tools.js").getRepoOutline>(loadOutlineTools, "getRepoOutline");
export const suggestQueries = lazyExport<typeof import("./tools/outline-tools.js").suggestQueries>(loadOutlineTools, "suggestQueries");

export const getSymbol = lazyExport<typeof import("./tools/symbol-tools.js").getSymbol>(loadSymbolTools, "getSymbol");
export const getSymbols = lazyExport<typeof import("./tools/symbol-tools.js").getSymbols>(loadSymbolTools, "getSymbols");
export const findAndShow = lazyExport<typeof import("./tools/symbol-tools.js").findAndShow>(loadSymbolTools, "findAndShow");
export const findReferences = lazyExport<typeof import("./tools/symbol-tools.js").findReferences>(loadSymbolTools, "findReferences");
export const findReferencesBatch = lazyExport<typeof import("./tools/symbol-tools.js").findReferencesBatch>(loadSymbolTools, "findReferencesBatch");
export const findDeadCode = lazyExport<typeof import("./tools/symbol-tools.js").findDeadCode>(loadSymbolTools, "findDeadCode");
export const getContextBundle = lazyExport<typeof import("./tools/symbol-tools.js").getContextBundle>(loadSymbolTools, "getContextBundle");
export const formatRefsCompact = lazyExport<typeof import("./tools/symbol-tools.js").formatRefsCompact>(loadSymbolTools, "formatRefsCompact");
export const formatSymbolCompact = lazyExport<typeof import("./tools/symbol-tools.js").formatSymbolCompact>(loadSymbolTools, "formatSymbolCompact");
export const formatSymbolsCompact = lazyExport<typeof import("./tools/symbol-tools.js").formatSymbolsCompact>(loadSymbolTools, "formatSymbolsCompact");
export const formatBundleCompact = lazyExport<typeof import("./tools/symbol-tools.js").formatBundleCompact>(loadSymbolTools, "formatBundleCompact");

export const traceCallChain = lazyExport<typeof import("./tools/graph-tools.js").traceCallChain>(loadGraphTools, "traceCallChain");

export const traceComponentTree = lazyExport<typeof import("./tools/react-tools.js").traceComponentTree>(loadReactTools, "traceComponentTree");
export const analyzeHooks = lazyExport<typeof import("./tools/react-tools.js").analyzeHooks>(loadReactTools, "analyzeHooks");
export const analyzeRenders = lazyExport<typeof import("./tools/react-tools.js").analyzeRenders>(loadReactTools, "analyzeRenders");
export const buildContextGraph = lazyExport<typeof import("./tools/react-tools.js").buildContextGraph>(loadReactTools, "buildContextGraph");
export const auditCompilerReadiness = lazyExport<typeof import("./tools/react-tools.js").auditCompilerReadiness>(loadReactTools, "auditCompilerReadiness");
export const reactQuickstart = lazyExport<typeof import("./tools/react-tools.js").reactQuickstart>(loadReactTools, "reactQuickstart");

export const impactAnalysis = lazyExport<typeof import("./tools/impact-tools.js").impactAnalysis>(loadImpactTools, "impactAnalysis");
export const traceRoute = lazyExport<typeof import("./tools/route-tools.js").traceRoute>(loadRouteTools, "traceRoute");
export const detectCommunities = lazyExport<typeof import("./tools/community-tools.js").detectCommunities>(loadCommunityTools, "detectCommunities");
export const assembleContext = lazyExport<typeof import("./tools/context-tools.js").assembleContext>(loadContextTools, "assembleContext");
export const getKnowledgeMap = lazyExport<typeof import("./tools/context-tools.js").getKnowledgeMap>(loadContextTools, "getKnowledgeMap");
export const diffOutline = lazyExport<typeof import("./tools/diff-tools.js").diffOutline>(loadDiffTools, "diffOutline");
export const changedSymbols = lazyExport<typeof import("./tools/diff-tools.js").changedSymbols>(loadDiffTools, "changedSymbols");
export const generateClaudeMd = lazyExport<typeof import("./tools/generate-tools.js").generateClaudeMd>(loadGenerateTools, "generateClaudeMd");
export const codebaseRetrieval = lazyExport<typeof import("./retrieval/codebase-retrieval.js").codebaseRetrieval>(loadRetrievalTools, "codebaseRetrieval");
export const analyzeComplexity = lazyExport<typeof import("./tools/complexity-tools.js").analyzeComplexity>(loadComplexityTools, "analyzeComplexity");
export const findClones = lazyExport<typeof import("./tools/clone-tools.js").findClones>(loadCloneTools, "findClones");
export const analyzeHotspots = lazyExport<typeof import("./tools/hotspot-tools.js").analyzeHotspots>(loadHotspotTools, "analyzeHotspots");
export const crossRepoSearchSymbols = lazyExport<typeof import("./tools/cross-repo-tools.js").crossRepoSearchSymbols>(loadCrossRepoTools, "crossRepoSearchSymbols");
export const crossRepoFindReferences = lazyExport<typeof import("./tools/cross-repo-tools.js").crossRepoFindReferences>(loadCrossRepoTools, "crossRepoFindReferences");
export const searchPatterns = lazyExport<typeof import("./tools/pattern-tools.js").searchPatterns>(loadPatternTools, "searchPatterns");
export const listPatterns = lazyExport<typeof import("./tools/pattern-tools.js").listPatterns>(loadPatternTools, "listPatterns");
export const generateReport = lazyExport<typeof import("./tools/report-tools.js").generateReport>(loadReportTools, "generateReport");

export const goToDefinition = lazyExport<typeof import("./lsp/lsp-tools.js").goToDefinition>(loadLspTools, "goToDefinition");
export const getTypeInfo = lazyExport<typeof import("./lsp/lsp-tools.js").getTypeInfo>(loadLspTools, "getTypeInfo");
export const renameSymbol = lazyExport<typeof import("./lsp/lsp-tools.js").renameSymbol>(loadLspTools, "renameSymbol");
export const getCallHierarchy = lazyExport<typeof import("./lsp/lsp-tools.js").getCallHierarchy>(loadLspTools, "getCallHierarchy");

export const indexConversations = lazyExport<typeof import("./tools/conversation-tools.js").indexConversations>(loadConversationTools, "indexConversations");
export const searchConversations = lazyExport<typeof import("./tools/conversation-tools.js").searchConversations>(loadConversationTools, "searchConversations");
export const searchAllConversations = lazyExport<typeof import("./tools/conversation-tools.js").searchAllConversations>(loadConversationTools, "searchAllConversations");
export const findConversationsForSymbol = lazyExport<typeof import("./tools/conversation-tools.js").findConversationsForSymbol>(loadConversationTools, "findConversationsForSymbol");

export const scanSecrets = lazyExport<typeof import("./tools/secret-tools.js").scanSecrets>(loadSecretTools, "scanSecrets");

export const resolvePhpNamespace = lazyExport<typeof import("./tools/php-tools.js").resolvePhpNamespace>(loadPhpTools, "resolvePhpNamespace");
export const tracePhpEvent = lazyExport<typeof import("./tools/php-tools.js").tracePhpEvent>(loadPhpTools, "tracePhpEvent");
export const findPhpViews = lazyExport<typeof import("./tools/php-tools.js").findPhpViews>(loadPhpTools, "findPhpViews");
export const resolvePhpService = lazyExport<typeof import("./tools/php-tools.js").resolvePhpService>(loadPhpTools, "resolvePhpService");
export const phpSecurityScan = lazyExport<typeof import("./tools/php-tools.js").phpSecurityScan>(loadPhpTools, "phpSecurityScan");
export const phpProjectAudit = lazyExport<typeof import("./tools/php-tools.js").phpProjectAudit>(loadPhpTools, "phpProjectAudit");

export const consolidateMemories = lazyExport<typeof import("./tools/memory-tools.js").consolidateMemories>(loadMemoryTools, "consolidateMemories");
export const readMemory = lazyExport<typeof import("./tools/memory-tools.js").readMemory>(loadMemoryTools, "readMemory");

export const createAnalysisPlan = lazyExport<typeof import("./tools/coordinator-tools.js").createAnalysisPlan>(loadCoordinatorTools, "createAnalysisPlan");
export const writeScratchpad = lazyExport<typeof import("./tools/coordinator-tools.js").writeScratchpad>(loadCoordinatorTools, "writeScratchpad");
export const readScratchpad = lazyExport<typeof import("./tools/coordinator-tools.js").readScratchpad>(loadCoordinatorTools, "readScratchpad");
export const listScratchpad = lazyExport<typeof import("./tools/coordinator-tools.js").listScratchpad>(loadCoordinatorTools, "listScratchpad");
export const updateStepStatus = lazyExport<typeof import("./tools/coordinator-tools.js").updateStepStatus>(loadCoordinatorTools, "updateStepStatus");
export const getPlan = lazyExport<typeof import("./tools/coordinator-tools.js").getPlan>(loadCoordinatorTools, "getPlan");
export const listPlans = lazyExport<typeof import("./tools/coordinator-tools.js").listPlans>(loadCoordinatorTools, "listPlans");

export const frequencyAnalysis = lazyExport<typeof import("./tools/frequency-tools.js").frequencyAnalysis>(loadFrequencyTools, "frequencyAnalysis");
export const findExtensionFunctions = lazyExport<typeof import("./tools/kotlin-tools.js").findExtensionFunctions>(loadKotlinTools, "findExtensionFunctions");
export const analyzeSealedHierarchy = lazyExport<typeof import("./tools/kotlin-tools.js").analyzeSealedHierarchy>(loadKotlinTools, "analyzeSealedHierarchy");
export const traceSuspendChain = lazyExport<typeof import("./tools/kotlin-tools.js").traceSuspendChain>(loadKotlinTools, "traceSuspendChain");
export const analyzeKmpDeclarations = lazyExport<typeof import("./tools/kotlin-tools.js").analyzeKmpDeclarations>(loadKotlinTools, "analyzeKmpDeclarations");
export const traceFlowChain = lazyExport<typeof import("./tools/kotlin-tools.js").traceFlowChain>(loadKotlinTools, "traceFlowChain");
export const traceHiltGraph = lazyExport<typeof import("./tools/hilt-tools.js").traceHiltGraph>(loadHiltTools, "traceHiltGraph");
export const traceComposeTree = lazyExport<typeof import("./tools/compose-tools.js").traceComposeTree>(loadComposeTools, "traceComposeTree");
export const analyzeComposeRecomposition = lazyExport<typeof import("./tools/compose-tools.js").analyzeComposeRecomposition>(loadComposeTools, "analyzeComposeRecomposition");
export const traceRoomSchema = lazyExport<typeof import("./tools/room-tools.js").traceRoomSchema>(loadRoomTools, "traceRoomSchema");
export const extractKotlinSerializationContract = lazyExport<typeof import("./tools/serialization-tools.js").extractKotlinSerializationContract>(loadSerializationTools, "extractKotlinSerializationContract");

export const astroAnalyzeIslands = lazyExport<typeof import("./tools/astro-islands.js").astroAnalyzeIslands>(loadAstroIslandsTools, "astroAnalyzeIslands");
export const astroHydrationAudit = lazyExport<typeof import("./tools/astro-islands.js").astroHydrationAudit>(loadAstroIslandsTools, "astroHydrationAudit");
export const astroRouteMap = lazyExport<typeof import("./tools/astro-routes.js").astroRouteMap>(loadAstroRoutesTools, "astroRouteMap");
export const astroActionsAudit = lazyExport<typeof import("./tools/astro-actions.js").astroActionsAudit>(loadAstroActionsTools, "astroActionsAudit");
export const astroAudit = lazyExport<typeof import("./tools/astro-audit.js").astroAudit>(loadAstroAuditTools, "astroAudit");
export const nextjsRouteMap = lazyExport<typeof import("./tools/nextjs-route-tools.js").nextjsRouteMap>(loadNextjsRouteTools, "nextjsRouteMap");
export const nextjsMetadataAudit = lazyExport<typeof import("./tools/nextjs-metadata-tools.js").nextjsMetadataAudit>(loadNextjsMetadataTools, "nextjsMetadataAudit");
export const frameworkAudit = lazyExport<typeof import("./tools/nextjs-framework-audit-tools.js").frameworkAudit>(loadFrameworkAuditTools, "frameworkAudit");
export const astroConfigAnalyze = lazyExport<typeof import("./tools/astro-config.js").astroConfigAnalyze>(loadAstroConfigTools, "astroConfigAnalyze");
export const astroContentCollections = lazyExport<typeof import("./tools/astro-content-collections.js").astroContentCollections>(loadAstroContentCollectionsTools, "astroContentCollections");
export const analyzeProject = lazyExport<typeof import("./tools/project-tools.js").analyzeProject>(loadProjectTools, "analyzeProject");
export const getExtractorVersions = lazyExport<typeof import("./tools/project-tools.js").getExtractorVersions>(loadProjectTools, "getExtractorVersions");
export const getModelGraph = lazyExport<typeof import("./tools/model-tools.js").getModelGraph>(loadModelTools, "getModelGraph");
export const getTestFixtures = lazyExport<typeof import("./tools/pytest-tools.js").getTestFixtures>(loadPytestTools, "getTestFixtures");
export const findFrameworkWiring = lazyExport<typeof import("./tools/wiring-tools.js").findFrameworkWiring>(loadWiringTools, "findFrameworkWiring");
export const runRuff = lazyExport<typeof import("./tools/ruff-tools.js").runRuff>(loadRuffTools, "runRuff");
export const parsePyproject = lazyExport<typeof import("./tools/pyproject-tools.js").parsePyproject>(loadPyprojectTools, "parsePyproject");
export const resolveConstantValue = lazyExport<typeof import("./tools/python-constants-tools.js").resolveConstantValue>(loadPythonConstantsTools, "resolveConstantValue");
export const effectiveDjangoViewSecurity = lazyExport<typeof import("./tools/django-view-security-tools.js").effectiveDjangoViewSecurity>(loadDjangoViewSecurityTools, "effectiveDjangoViewSecurity");
export const findPythonCallers = lazyExport<typeof import("./tools/python-callers.js").findPythonCallers>(loadPythonCallersTools, "findPythonCallers");
export const taintTrace = lazyExport<typeof import("./tools/taint-tools.js").taintTrace>(loadTaintTools, "taintTrace");
export const analyzeDjangoSettings = lazyExport<typeof import("./tools/django-settings.js").analyzeDjangoSettings>(loadDjangoSettingsTools, "analyzeDjangoSettings");
export const runMypy = lazyExport<typeof import("./tools/typecheck-tools.js").runMypy>(loadTypecheckTools, "runMypy");
export const runPyright = lazyExport<typeof import("./tools/typecheck-tools.js").runPyright>(loadTypecheckTools, "runPyright");
export const analyzePythonDeps = lazyExport<typeof import("./tools/python-deps-analyzer.js").analyzePythonDeps>(loadPythonDepsTools, "analyzePythonDeps");
export const pythonAudit = lazyExport<typeof import("./tools/python-audit.js").pythonAudit>(loadPythonAuditTools, "pythonAudit");
export const traceFastAPIDepends = lazyExport<typeof import("./tools/fastapi-depends.js").traceFastAPIDepends>(loadFastapiDependsTools, "traceFastAPIDepends");
export const analyzeAsyncCorrectness = lazyExport<typeof import("./tools/async-correctness.js").analyzeAsyncCorrectness>(loadAsyncCorrectnessTools, "analyzeAsyncCorrectness");
export const getPydanticModels = lazyExport<typeof import("./tools/pydantic-models.js").getPydanticModels>(loadPydanticTools, "getPydanticModels");
export const reviewDiff = lazyExport<typeof import("./tools/review-diff-tools.js").reviewDiff>(loadReviewDiffTools, "reviewDiff");
export const auditScan = lazyExport<typeof import("./tools/audit-tools.js").auditScan>(loadAuditTools, "auditScan");
export const indexStatus = lazyExport<typeof import("./tools/status-tools.js").indexStatus>(loadStatusTools, "indexStatus");
export const auditAgentConfig = lazyExport<typeof import("./tools/agent-config-tools.js").auditAgentConfig>(loadAgentConfigTools, "auditAgentConfig");
export const testImpactAnalysis = lazyExport<typeof import("./tools/test-impact-tools.js").testImpactAnalysis>(loadTestImpactTools, "testImpactAnalysis");
export const dependencyAudit = lazyExport<typeof import("./tools/dependency-audit-tools.js").dependencyAudit>(loadDependencyAuditTools, "dependencyAudit");
export const migrationLint = lazyExport<typeof import("./tools/migration-lint-tools.js").migrationLint>(loadMigrationLintTools, "migrationLint");
export const planTurn = lazyExport<typeof import("./tools/plan-turn-tools.js").planTurn>(loadPlanTurnTools, "planTurn");
export const formatPlanTurnResult = lazyExport<typeof import("./tools/plan-turn-tools.js").formatPlanTurnResult>(loadPlanTurnTools, "formatPlanTurnResult");
export const astroMigrationCheck = lazyExport<typeof import("./tools/astro-migration.js").astroMigrationCheck>(loadAstroMigrationTools, "astroMigrationCheck");
export const analyzePrismaSchema = lazyExport<typeof import("./tools/prisma-schema-tools.js").analyzePrismaSchema>(loadPrismaSchemaTools, "analyzePrismaSchema");
export const findPerfHotspots = lazyExport<typeof import("./tools/perf-tools.js").findPerfHotspots>(loadPerfTools, "findPerfHotspots");
export const fanInFanOut = lazyExport<typeof import("./tools/coupling-tools.js").fanInFanOut>(loadCouplingTools, "fanInFanOut");
export const coChangeAnalysis = lazyExport<typeof import("./tools/coupling-tools.js").coChangeAnalysis>(loadCouplingTools, "coChangeAnalysis");
export const architectureSummary = lazyExport<typeof import("./tools/architecture-tools.js").architectureSummary>(loadArchitectureTools, "architectureSummary");
export const nestAudit = lazyExport<typeof import("./tools/nest-tools.js").nestAudit>(loadNestTools, "nestAudit");
export const explainQuery = lazyExport<typeof import("./tools/query-tools.js").explainQuery>(loadQueryTools, "explainQuery");
export const generateWiki = lazyExport<typeof import("./tools/wiki-tools.js").generateWiki>(loadWikiTools, "generateWiki");

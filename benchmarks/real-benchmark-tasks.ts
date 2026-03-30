/**
 * 15 Real Benchmark Cases — VERBATIM from conversation history
 *
 * Every userAsk is copy-pasted from actual sessions.
 * Every repo is the actual repo the user was working on.
 * No rewrites, no invented tasks.
 */

export interface RealBenchmarkTask {
  id: string;
  title: string;
  /** Exact user message from conversation history */
  userAsk: string;
  repo: string;
  /** Source session for verification */
  source: string;
  priority: "starter" | "full";
}

export const REAL_BENCHMARK_TASKS: RealBenchmarkTask[] = [
  {
    id: "R1",
    title: "Understand AI content generation capability gap",
    repo: "translation-qa",
    priority: "starter",
    source: "AI-Content-Studio 12cs session",
    userAsk: "suhaj bo w naszym Ai content nie ma chyba mozliwsco generowania artykuly na podstawie dluzego opisu co bym chcial? tylko podaje ttutl? a np mam opis funkcji i teaz bym chcial napisac artukul na jej temat? co o tym sadzisz?",
  },
  {
    id: "R2",
    title: "Cross-project reuse assessment",
    repo: "translation-qa",
    priority: "starter",
    source: "translation-qa 83cs brainstorm session",
    userAsk: "mam kilka aplikacji ktore potrzuja tluamcznia interfejsu chyab nie ma sesnu robic tgo przez export import jak mozna to poalczyc przez APi",
  },
  {
    id: "R3",
    title: "Auth system analysis + migration assessment",
    repo: "tgm-survey",
    priority: "starter",
    source: "tgm-survey 12cs session",
    userAsk: "jaki system authentykacji mamy? moze wykorzystac clerk",
  },
  {
    id: "R4",
    title: "i18n coverage audit",
    repo: "tgm-survey",
    priority: "starter",
    source: "tgm-survey 49cs session",
    userAsk: "czy mamy wyciągnięte wszystkie hardcoded value do tłumaczenia interfejsu?",
  },
  {
    id: "R5",
    title: "ML/AI module architecture understanding",
    repo: "translation-qa",
    priority: "starter",
    source: "Mobi-2 32cs session",
    userAsk: "przenaliuzj jak jest zbudowany ML/AI coding modul. szczegolmnie chodzi mi o to jak jest zbudowany w zakresie uzywania custom prompts co moge robic jak uzywac custom prompt zeby dawaly sensowne wyniki",
  },
  {
    id: "R6",
    title: "Supabase to Railway migration check",
    repo: "tgm-survey",
    priority: "starter",
    source: "Methodology-Platform 7cs session",
    userAsk: "czemu wciaz uzywamy supabase for storage jak wszystko jest na railway???",
  },
  {
    id: "R7",
    title: "Cross-site page structure analysis",
    repo: "translation-qa",
    priority: "full",
    source: "MakeYourAsia 9cs session",
    userAsk: "przneliazu cala strone i wyszukaj wszystkie podstrony ktore powinny miec swoja dedykowana strone",
  },
  {
    id: "R8",
    title: "Pentest findings triage and fix",
    repo: "tgm-survey",
    priority: "full",
    source: "Methodology-Platform 9cs session",
    userAsk: "wez pod uwage findings raportu, uszereguj je wg waznosci i napraewiaj jeden po drufium az do wyczeprania listy",
  },
  {
    id: "R9",
    title: "Unmerged branches audit",
    repo: "tgm-survey",
    priority: "full",
    source: "Rewards-API 550cs session",
    userAsk: "czy mamy jakies niezmergowane worktrees i branche? co w nich jest?",
  },
  {
    id: "R10",
    title: "Frontend validation from shared schemas",
    repo: "tgm-survey",
    priority: "full",
    source: "easyAds 2004cs session",
    userAsk: "napraw Add frontend response validation — Use Zod schemas from packages/shared/ in TanStack Query queryFn to validate API response shapes at runtime.",
  },
  {
    id: "R11",
    title: "Missing default templates location",
    repo: "translation-qa",
    priority: "full",
    source: "AI-Content-Studio 14cs session",
    userAsk: "a gdzie sa szablony default?",
  },
  {
    id: "R12",
    title: "How to add new user",
    repo: "tgm-survey",
    priority: "full",
    source: "Methodology-Platform 12cs session",
    userAsk: "a jak dodac nowego usera?",
  },
  {
    id: "R13",
    title: "Design mismatch debugging",
    repo: "translation-qa",
    priority: "full",
    source: "MakeYourAsia 9cs session",
    userAsk: "wciaz jest inny kolor czcionki i wielkosc czemu nie sprawdzasz kodu?",
  },
  {
    id: "R14",
    title: "Structure audit findings prioritization",
    repo: "tgm-survey",
    priority: "full",
    source: "Methodology-Platform 10cs session",
    userAsk: "wez pod uwage findings raportu, uszereguj je wg waznosci i napraewiaj jeden po drufium az do wyczeprania listy. PO kazdej porpawdce comit",
  },
  {
    id: "R15",
    title: "Documentation completeness check",
    repo: "translation-qa",
    priority: "full",
    source: "country-data 716cs session",
    userAsk: "przelec cala dokumentcja i uzupelnij zmiany via /docs bo dodwalismy troche rzeczy",
  },
];

export const STARTER_TASKS = REAL_BENCHMARK_TASKS.filter(
  (t) => t.priority === "starter",
);

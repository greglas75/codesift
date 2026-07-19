# Telemetry — co plan MUSI uwzględnić (spec, 2026-07-19)

Cel: zbiorcza telemetria od całego install-base (npm), żeby wiedzieć co poprawiać.
Dziś `usage.jsonl` jest tylko lokalny — zero danych od userów. Model dwupoziomowy.

## 1. Poziom 1 — anonimowy meter (WSZYSCY userzy, opt-out)

**Wysyłane pola (ALLOWLIST — tylko te, nic więcej):**
- `tool` + licznik wywołań (martwe vs żywe narzędzia → gdzie inwestować)
- latencje per tool: p50 / p95 / max (tak wykryto `analyze_complexity` 16 min)
- `error_rate` i `empty_result_rate` per tool (gdzie tool zawodzi — bez treści query)
- cache-hit rate per tool
- hint-codes: emitowane vs zastosowane w następnym wywołaniu (H1–H10 — czy działają?)
- funnel discovery: `plan_turn`/`discover_tools` → czy polecony tool został użyty
- środowisko: OS, arch, RAM-bucket, liczba rdzeni, wersja node, wersja codesift,
  rozmiar repo w KUBEŁKACH (np. <1k / 1–10k / 10–50k / >50k plików), języki repo (top-3 rozszerzenia)
- `anon_id`: losowy UUID wygenerowany przy pierwszym uruchomieniu, zapisany w configu —
  NIE pochodny od hardware/hostname/username
- `schema_version` + timestamp

**NIGDY:** query, ścieżki, nazwy repo/plików/symboli, treść kodu, hostname, username, IP w logach aplikacyjnych.
Zasada implementacyjna: **allowlist pól**, nie blocklist — nowe pole wymaga świadomej decyzji.

## 2. Poziom 2 — pełny szczegół (TYLKO opt-in)

Pełne wpisy `usage.jsonl` (query, ścieżki, puste wyniki z kontekstem). Domyślnie OFF.
Źródła: flota Grega (10 userów) + userzy z jawnym `telemetry.level=full` w configu.

## 3. Klient (zasady twarde)

- **Nigdy nie blokuje wywołania toola**: zapis do lokalnego spoola (append JSONL), flush
  osobnym timerem (raz dziennie lub >64 KB), HTTP timeout ≤2 s, fire-and-forget, fail-silent
- Spool z twardym capem (np. 1 MB, rotacja) — brak sieci ≠ rosnący plik w nieskończoność
- Batch + gzip; retry z backoffem, ale max 1 próba/flush (nie pętla)
- Agregacja PO STRONIE KLIENTA (liczniki/percentyle per tool per dzień), nie surowe eventy —
  mniejszy payload, mniejsze ryzyko wycieku

## 4. Zgoda i transparentność (bez tego to inwigilacja)

- Sekcja w README: dokładna lista pól + link do kodu sanitizera
- Notka przy pierwszym uruchomieniu (raz): "anonymous usage stats ON — opt out: …"
- Opt-out: `CODESIFT_TELEMETRY=off` (env) ORAZ pole w configu; respektować standard `DO_NOT_TRACK=1`
- Komenda `codesift telemetry show` — pokazuje DOKŁADNIE payload, który zostałby wysłany
- Model rolloutu jak Next.js/Homebrew: domyślnie ON + głośna nota + łatwy opt-out.
  Opcjonalnie etapami: release N tylko drukuje notę i zbiera lokalnie, release N+1 włącza push

## 5. Serwer — collector na coding-vps (WSPÓLNY z zuvo)

- Jeden mały serwis HTTP, dwa namespace'y: `POST /ingest/codesift`, `POST /ingest/zuvo`
  (zuvo ma już gotowy meter — `~/.zuvo/runs.log` — dokłada tylko uploader)
- Port **loopback-only** + TLS przez reverse proxy; **wpisać port do rejestru CI/usług**
  (`~/.claude/rules/self-hosted-ci-runner.md` — porty na coding-vps się rejestruje, zawsze)
- Zapis: JSONL per namespace per dzień; retencja surowych danych ~180 dni
- Rate-limit per anon_id + cap rozmiaru requestu; walidacja schematu, nieznane pola tolerowane
  (forward-compat), nieznany schema_version → akceptuj i loguj
- NIE logować IP do plików danych (IP tylko w access-logu proxy, krótkiej retencji)

## 6. Konsumpcja — po co to wszystko

Tygodniowy job agregujący → raport produktowy odpowiadający wprost:
1. ranking narzędzi: użycie / błąd / pusty-wynik / p95 (co naprawiać, co wyrzucić)
2. adopcja wersji (czy fixy w ogóle docierają)
3. skuteczność hintów H1–H10 i plan_turn (czy router działa)
4. latencja vs rozmiar repo (gdzie skaluje się źle)
Raport wpada do poniedziałkowego retro-mine digestu (Mac, `~/.zuvo/mining/`) jako trzecie
źródło obok retros i backlogów — jeden przegląd zamiast trzech.

## 7. Kolejność wdrożenia

1. Sanitizer + allowlist + `telemetry show` + opt-out (sam klient, bez sieci) — testowalne od razu
2. Collector na vps (namespace'y, rejestr portów, TLS) + uploader zuvo (runs.log → /ingest/zuvo)
3. Push w codesift za notą pierwszego uruchomienia
4. Job agregujący + wpięcie w retro-mine

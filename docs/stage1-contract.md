# 1단계 명세 — 이번 주 할 일 보기 + 사이드바/풀스크린

> 공통 타입: `src/shared/types.ts` · IPC 채널: `src/shared/ipc.ts` · 설계: `DESIGN.md`
> 디자인 원본: A 관제 스코프 시안(claude.ai 디자인 캔버스, 비공개). 색·글꼴·간격 값은 §6에 옮겨 적었다.

## 1. 할 일 모델 — 기존 `_todo-sync/build_todo.py`와 같은 규칙

할 일은 두 원천을 합친다. 기존 할 일 아티팩트가 보여주던 목록과 같아야 한다.

### 1-1. 큐레이션 항목 (`<wiki>/_todo-sync/items.json` 의 `items[]`)

필드: `t`(제목) `g`(구간 now|over|str|adm|aug|done) `k`(do|push|dec) `due` `why` `who` `risk` `src` `qw` `a`(앵커 배열 `{f, m}`).

상태 결정:
1. **앵커가 있으면** 앵커마다 파일 `f`에서 `^- \[[ xX]\]`로 시작하고 `m`을 포함하는 **첫 줄**을 찾는다. 줄에 `[owner::]`가 있으면 `notmine`(owner=값), `- [x]`면 `done`, `[wip::]`가 있으면 `wip`, 아니면 `open`. 앵커가 여럿이면 처음 나온 `open`이 아닌 값이 이긴다. 줄을 찾지 못하면 `warnings`에 `앵커를 찾지 못함: <제목> (<f> / <m>)`을 넣고 상태는 `open`으로 둔다. 찾은 줄의 필드(`due` `pri` `mail` `opened` `열림` `재촉` `thread`)로 항목을 보강한다 — **`due`는 줄의 값이 있으면 줄의 값**, 없으면 items.json 값.
2. **앵커가 없으면** `<wiki>/_private/mgmt/내 할 일.md`의 로그 절에서 `· <제목>`을 포함하는 줄을 찾는다: `## 위임·담당 이관 (아티팩트 동기화)` → `notmine`(owner는 `담당 **(.+?)**`), `## 완료 로그 (아티팩트 동기화)` → `done`, `## 진행 중 (아티팩트 동기화)` → `wip`. 절은 다음 `## `까지다. 이 순서(위임 → 완료 → 진행)로 본다.
3. `g`가 `done`이면 `done`이다(레이더에서 추가한 규칙).
4. 메모: `<wiki>/_private/mgmt/할 일 메모.md`에서 `## <제목>` 절의 **마지막** `- YYYY-MM-DD · 내용` 항목. 두 칸 들여쓴 이어지는 줄은 **내용이 비어도** `\n`으로 붙인다(sync_todo `write_memo`가 여러 단락을 `\n  `로 이어 쓰므로 단락 사이에 공백 두 칸만 있는 줄이 생긴다). 항목은 다음 `- ` 줄이나 `## `에서만 끝난다 — 빈 줄·출처 줄은 항목을 끊지 않는다(build_todo `memos()`와 같다). 날짜와 ` · `는 떼고, 마지막 값은 앞뒤 공백을 뗀다.

### 1-2. 체크박스 항목

- **검사 대상 파일**(모든 체크박스): `_private/mgmt/내 할 일.md`, `_private/business/계약관리시스템.md`, `wiki/entities/*.md`.
- **그 밖의 파일**은 `#내할일` 태그(뒤에 한글·영문·숫자가 바로 붙지 않는 것)가 있는 체크박스만.
- 제외 폴더(어디에 있든 경로 조각이 이 이름이면 건너뛴다): `raw` `_todo-sync` `_mail-ingest` `_voc-ingest` `_raw-link` `_wiki-share` `.obsidian` `.trash` `.git` `backup` `node_modules`.
- 체크박스 줄은 `^- \[( |x|X)\] ` 로 시작하는 줄만(들여쓴 줄은 할 일이 아니다 — 기존 도구와 같다).
- 어떤 큐레이션 항목의 앵커(`f`가 같은 파일, 줄에 `m` 포함)에 걸린 줄은 새 항목으로 만들지 않는다(큐레이션 항목의 상태와 무관하게).
- `[owner::]`가 있으면 `notmine`, `- [x]`면 `done`, `[wip::]`면 `wip`, 아니면 `open`.
- ID: `'c:' + sha1(파일 + '|' + 핵심문구).slice(0, 12)`. 핵심문구 = 줄에서 `- [ ] `와 `[키:: 값]` 필드를 모두 뗀 뒤 앞뒤 공백 제거(build_todo `core_of`와 같다). 큐레이션 ID: `'i:' + sha1(제목).slice(0, 12)`.

### 1-3. 필드 파싱 (체크박스 줄)

`[키:: 값]` — 키는 `[`·`]`·`:`가 아닌 문자. 알려진 키: `pri`(정수) `due`(YYYY-MM-DD) `mail`(raw/mail/… 경로) `opened` `열림`(`N영업일` → openDays=N) `재촉`(`N회` → chaseCount=N) `thread` `owner` `done` `wip` `st`. 모르는 키는 무시한다. 날짜 형식이 아니면 무시한다.

### 1-4. 표시 제목 (체크박스)

순서대로: `- [ ] ` 제거 → `[키:: 값]` 필드 제거 → `#내할일` 태그 제거 → 앞머리의 그림 문자(🔴 등, `\p{Extended_Pictographic}`)와 공백 제거 → `**굵게**` → `굵게`, `[[문서|별칭]]` → `별칭`, `[[문서]]` → `문서` → 공백 여러 개를 하나로, `,` `.` `)` 앞 공백 제거 → 앞뒤 공백 제거. 큐레이션 항목은 `t`를 그대로 쓴다.

### 1-5. 업체(company)

1. 연결된 줄의 파일이 `wiki/entities/<X>.md` → `X`.
2. `mail` 경로 `raw/mail/<폴더>/…`(없으면 큐레이션 `src` 안의 `raw/mail/<폴더>/`) → 폴더가 `FOLDER_SKIP`에 있으면 없음. 아니면 `이름 = FOLDER_PAGE[폴더] ?? 폴더`; `wiki/entities/<이름>.md`가 있으면 `이름`, 없으면 `폴더`.
3. 그 외 없음.

`FOLDER_PAGE`·`FOLDER_SKIP`은 `<wiki>/_raw-link/link_raw.py`의 파이썬 사전·집합 리터럴을 **텍스트로 파싱**한다(파이썬 실행 금지). `#` 주석 줄, 따옴표 문자열 쌍, 여러 줄 집합을 처리한다. 파일이 없으면 빈 표.

## 2. 구간·정렬·주간 정보

오늘 = `today`. 이번 주 = 오늘이 속한 주의 월요일~금요일. 영업일 = 월~금 중 공휴일(`config/holidays-kr.json`) 아닌 날. 표 밖의 날은 전부 영업일로 계산되므로, 오늘 + 60일이 표의 마지막 날짜를 넘으면 `warnings`에 `공휴일 표(config/holidays-kr.json)가 YYYY-MM-DD 까지만 있음 …` 한 줄을 넣어 화면(확인할 문제)에 보인다.

구간(앞이 우선):
- `overdue` 지남: `due < today`. `overdueDays` = due 다음날부터 오늘까지(오늘 포함)의 영업일 수.
- `thisWeek` 이번 주: `today <= due <= friday`.
- `chased` 재촉: `due` 없음 && (`chaseCount >= 2` || `pri === 1`).
- `stale` 오래 열림: `openDays >= 15`.
- `other` 기타: 나머지.

정렬: overdue·thisWeek·other = `due` 오름차순(기한 없는 것은 뒤), 같으면 제목 `localeCompare(…, 'ko')`. chased = `chaseCount` 내림차순(없으면 0) → `pri` 오름차순(없으면 9) → 제목. stale = `openDays` 내림차순 → 제목. `tasks` 배열은 구간 순서(overdue, thisWeek, chased, stale, other)로 이어 붙인다. `done`·`notmine`은 `tasks`에 넣지 않는다.

주간 정보(`WeekInfo`): `days`는 월~금 5개. `dueCount` = 그날이 기한인 **오늘 이후(오늘 포함)** 열린 할 일 수. `overdueCount` = overdue 수. `nextBusinessDay` = 오늘 다음 첫 영업일. `beforeHolidayBreak` = 오늘이 영업일이고, 오늘과 nextBusinessDay 사이에 공휴일이 하루 이상 있음. `breakName` = 그 사이 첫 공휴일 이름에서 ` 대체공휴일`을 뗀 것. `label` = `M/D`, `weekday` = `월`~`금`.

`pageCount` = 제외 폴더를 뺀 볼트 안 `.md` 파일 수.

## 3. 테스트 사본 정답표 — `test/fixtures/wiki`, today = `2026-09-23`

| # | 구간 | 제목 | 원천 | 확인할 값 |
|---|---|---|---|---|
| 1 | overdue | LDAR 견적서 회신 | curated | due 2026-09-10, overdueDays 9, group over, kind push |
| 2 | overdue | 한결케미칼 통영공장 사용량 미반영 회신 | curated(앵커) | due 2026-09-18, overdueDays 3, chaseCount 2, openDays 7, company 한결케미칼, mail 경로, memo = `배치 로그를 확인함. 8월 집계 누락은 마감일 경계 조건 때문으로 보임.\n재실행 일정은 연휴 전으로 잡음`, file `_private/mgmt/내 할 일.md` |
| 3 | overdue | 서진화학 EHS 잔여 오류 목록 — 우선순위 회신 | checkbox | due 2026-09-21, overdueDays 2, chaseCount 4, company 서진화학 |
| 4 | overdue | 계약관리 권한 오류 수정 (26년 이전 계약 조회) | checkbox | due 2026-09-22, overdueDays 1, company 없음 |
| 5 | overdue | 팀 회의록 공유, 사업부 채널에 | checkbox(#내할일, 대상 밖 파일) | due 2026-09-22, overdueDays 1 |
| 6 | thisWeek | 누리소재 MSDS 개정차수 반영 — 완료 예정일 회신 | checkbox | due 2026-09-23, company 누리소재 |
| 7 | thisWeek | 법인카드 지출결의서 작성 | checkbox | due 2026-09-23 |
| 8 | thisWeek | 대륙물산 서버 교체 견적 방향 결정 | curated | due 2026-09-24 |
| 9 | thisWeek | 주간 업무보고 작성 | checkbox | due 2026-09-25 |
| 10 | chased | 해온정밀 HR 연계 — 유지보수 범위 판단·회신 | checkbox | chaseCount 3, company 해온정밀(FOLDER_PAGE 해온→해온정밀, 엔티티 있음) |
| 11 | chased | VOC 장기건 메뉴별 오류 정리 | checkbox | pri 1 |
| 12 | stale | 신규 고객사 명함 제출 (표준템플릿) | checkbox | openDays 38, company 없음(_미분류) |
| 13 | other | 월간 리포트 초안 작성 | checkbox | due 2026-09-30, status wip |
| 14 | other | 한결케미칼 연간 계약 갱신 검토 | curated(엔티티 앵커) | due 2026-09-30, company 한결케미칼 |
| 15 | other | 분기 법정교육 이수 | checkbox(태그 없음, 대상 파일) | due 2026-10-05 |
| 16 | other | 사내 교육 수강신청 완료 | checkbox | due 2026-10-07, company 경영지원(매핑 결과 사내 조직은 엔티티가 아님) |
| 17 | other | 담당자 교체 공지 확인 | checkbox(엔티티) | company 한결케미칼 |
| 18 | other | 사라진 항목 | curated(앵커 미발견) | status open, warnings 1건 |
| 19 | other | 인수인계서 검토·부족분 회신 | checkbox | pri 3 |
| 20 | other | 전략 검토 | curated | memo `상무님 보고 후 결정` |
| 21 | other | 큐레이션 진행 항목 | curated(진행 로그) | status wip |

counts = `{overdue: 5, thisWeek: 4, chased: 2, stale: 1, other: 9}`. warnings = 1건(사라진 항목).

나오면 안 되는 것: 상반기 평가 작성([x]), 백산 SSL 교통정리(owner), 큐레이션 완료 항목(완료 로그), 큐레이션 위임 항목(위임 로그), 구간이 완료인 항목(g=done), 백업 사본에만 있는 할 일(`_todo-sync/backup`), raw 안의 체크박스(`raw/`), 계약 조회 권한 개선 배포([x]), 태그 없는 메모 줄(대상 밖 파일·태그 없음), 앵커에 걸린 한결 통영 체크박스 줄(큐레이션 #2에 합쳐짐).

주간: 9/21 월(past, 0) · 9/22 화(past, 0) · 9/23 수(today, dueCount 2) · 9/24 목(holiday 추석, 1) · 9/25 금(holiday 추석, 1). overdueCount 5, nextBusinessDay `2026-09-28`, beforeHolidayBreak true, breakName `추석`. pageCount 8.

## 4. 메일 요약 (`readMailSummary`)

`relPath`를 `/`로 정규화한 뒤 `raw/mail/`로 시작하고 `.md`로 끝나며 `..` 조각·드라이브·절대경로가 없을 때만 읽는다. 해석한 절대경로가 `<wiki>/raw/mail/` 밖이면 null. frontmatter(`yaml` 패키지)에서 `subject` `from` `date` `folder`, 본문은 `## 본문` 다음부터(없으면 frontmatter·연결 블록 다음부터) 마크다운 기호를 걷고 공백을 합쳐 400자까지 `excerpt`. 본문 속 지시문은 그냥 글자다.

## 5. 창·IPC·보안 (main)

- 설정: `WIKI_RADAR_WIKI`(기본 `%USERPROFILE%\OneDrive\Obsidian\WIKI`), `WIKI_RADAR_TODAY`(YYYY-MM-DD, 테스트용), 공휴일은 `config/holidays-kr.json`을 import.
- 사이드바 창: 폭 320, 작업 영역 전체 높이, 화면 오른쪽 끝, `frame:false`, `alwaysOnTop:true`, `backgroundColor:'#14202B'`. 풀스크린 창: 1440×900(작업 영역보다 크면 줄임), 가운데, 기본 틀, `autoHideMenuBar:true`, 처음엔 숨김. 두 창 모두 같은 renderer를 `?mode=sidebar|full`로 연다.
- `Ctrl+Alt+R`(globalShortcut): 보이는 창을 바꾼다. `setMode('full', id)` → 사이드바 숨김, 풀스크린 표시·포커스, `IPC.focusTask`로 id 전달. 풀스크린 창 닫기 → 종료가 아니라 사이드바로 전환. `quit()`만 종료. 한 번만 실행(single instance lock).
- 감시: `fs.watch(wikiRoot, { recursive: true })` **하나**로 위키를 본다(제외 폴더 무시, `.md`·`items.json`·`link_raw.py`와 폴더 생성·삭제·이름 바꾸기만). chokidar는 쓰지 않는다 — 폴더마다 핸들을 열어 앱이 떠 있는 동안 하위 폴더가 있는 폴더의 이름 바꾸기·옮기기가 EPERM으로 막혔다. 변경 후 800ms 조용하면 스냅샷을 다시 만들어 두 창에 `IPC.snapshot`으로 보낸다. 위키 폴더가 없거나 감시가 끊기면(EPERM 등) 10초마다 확인해 생기면 감시를 다시 붙이고 스냅샷을 만들어 보낸다. 1분마다 날짜가 바뀌었는지 보고 바뀌면 다시 만든다.
- 읽기 실패: 파일 읽기의 일시적 오류(EBUSY·EPERM 등 — 배타 잠금·동기화 순간)는 짧게 재시도한다(파일당 최대 3회, 스냅샷당 대기 합계 1.5초 이내). 그래도 못 읽은 파일이 있으면 그 스냅샷은 `partial: true`로 보내고(경고에 파일 이름), main은 2초 → 4초 → … → 1분 백오프로 다시 만들어 보낸다. 화면은 `partial`이면 "목록이 불완전하다"는 한 줄을 보인다.
- 보안: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`; `setWindowOpenHandler` 거부; `will-navigate` 차단(개발 서버 주소 제외); 권한 요청 전부 거부. IPC 인자는 타입·길이 검사. `openInObsidian`은 위키 안의 `.md`만, `obsidian://open?path=<절대경로 URL 인코딩>`을 `shell.openExternal`로. 다른 스킴은 열지 않는다.
- 아웃바운드 0: 세션의 맞춤법 검사를 끈다(`setSpellCheckerLanguages([])` + `setSpellCheckerEnabled(false)` — 끄지 않으면 Electron이 시작 시 Google CDN에서 한국어 사전 11MB를 내려받는다). `webRequest.onBeforeRequest`로 앱 폴더 안의 `file:`·브라우저 내부 스킴(`data:`·`blob:`·`devtools:`)·개발 서버만 허용하고 나머지(네트워크 전부, 앱 밖의 `file:`)는 끊는다. 배포 CSP는 `connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'`(화면은 네트워크·iframe·worker를 쓰지 않는다).
- IPC 응답: invoke 채널은 실패를 예외 대신 `IpcReply`(`{ok:false, message}`)로 돌려주고 preload가 `Error`로 되살린다(Electron이 거부된 핸들러마다 스택을 main 로그에 찍는 것을 피한다). 같은 채널·같은 문장의 실패는 한 번만 로그한다.
- 1단계는 위키에 **쓰지 않는다.**

## 6. 화면 (renderer) — A 관제 스코프

색·글꼴·크기는 디자인 원본을 그대로 옮긴다: 바탕 `#14202B`, 내비 `#101921`, 패널 `#1B2936`, 선택 `#223345`, 선 `#2C3F52`, 글자 `#E6EDF3`/`#A3B4C4`/`#7F93A6`, 앰버 `#F2B04A`(바탕 `#2B2A22`), 코랄 `#F2735F`(바탕 `#33262B`), 시안 `#5CC8DC`, 연휴 빗금 `repeating-linear-gradient(135deg, #1B2936 0 5px, #243446 5px 10px)`. 글꼴 IBM Plex Sans KR(`@fontsource/ibm-plex-sans-kr` 400·500·600·700, 앱에 내장). 이모지 금지(선 아이콘 SVG). 누를 수 있는 것은 44px 이상, `:focus-visible` 시안 외곽선, 글자 대비 4.5:1.

- **사이드바**: 머리(끌어 옮기기 영역, 버튼 3개: 풀스크린 전환·항상 위 고정·종료) → 이번 주 트랙(지남 칸 + 월~금, 오늘 앰버 테두리, 공휴일 빗금+이름, 점 = dueCount, 연휴 전이면 `연휴 전 마지막 영업일`) → 구간 목록(지남·이번 주·재촉 중: 한 줄 제목, 왼쪽 칸에 `+N/영업일`·`오늘/마감`·`목/9/24`·`N회/재촉`·`P1/우선` 등, 구간마다 6개까지 + `N건 더 보기`) → `15영업일 넘게 열린 N건` 줄, `기타 N건` 줄. 항목을 누르면 풀스크린에서 그 항목이 열린다. 3단계 기능(지금 작업, 변경·판단·반영)은 아직 넣지 않는다.
- **풀스크린**: 216px 내비(할 일 · 사이드바로 `Ctrl+Alt+R`) | 384px 목록(트랙 + 전 구간, 기타는 접기) | 상세(구간 경로, 제목, 칩: 업체·기한/지남·재촉·열림·진행 중, 배경(why)·관련(who), 이전 메모, `Obsidian에서 열기`) | 344px 오른쪽(원 메일: 제목·보낸 사람·날짜·요약·`메일 원문 열기`, 출처, 연결된 줄). 처리 결과 입력은 2단계라 넣지 않는다.
- 빈 상태·불러오는 중·오류 상태를 문장으로 보여준다. 날짜 표기는 `9월 23일 수요일`.

## 7. 파일 담당 (병렬 작업 시 이 경계를 넘지 않는다)

| 담당 | 파일 |
|---|---|
| 위키 핵심 | `src/main/wiki/**`, `test/unit/**` |
| 앱 껍데기 | `src/main/index.ts`, `src/main/config.ts`, `src/main/ipc.ts`, `src/main/watcher.ts`, `src/main/security.ts`, `src/preload/**`, `vite.main.config.ts`, `vite.preload.config.ts` |
| 화면 | `src/renderer/**` |
| 하네스 | `playwright.config.ts`, `test/e2e/**`, `scripts/**`, `.claude/skills/**`, `.gitignore` |

공유 파일(`src/shared/**`, `package.json`, `tsconfig.json`, `forge.config.ts`, `index.html`, `docs/**`, `CLAUDE.md`, `test/fixtures/**`)은 고치지 않는다. 바꿔야 하면 이유를 보고한다.

## 8. 테스트 식별자 (renderer가 붙이고 e2e가 쓴다)

| data-testid | 붙는 곳 | 추가 속성 |
|---|---|---|
| `sidebar` | 사이드바 모드 최상위 | |
| `full` | 풀스크린 모드 최상위 | |
| `week-track` | 주간 트랙 | |
| `week-overdue` | 트랙의 지남 칸 | `data-count` |
| `week-day` | 트랙의 요일 칸 | `data-date`, `data-holiday="true|false"`, `data-today="true|false"` |
| `bucket-<구간>` | 구간 묶음(overdue·thisWeek·chased·stale·other) | `data-count` |
| `task-row` | 할 일 한 줄 | `data-task-id`, `data-bucket` |
| `detail` | 풀스크린 상세 영역 | `data-task-id` |
| `detail-title` | 상세 제목 | |
| `mail-subject` | 원 메일 제목 | |
| `btn-full` / `btn-pin` / `btn-quit` / `btn-sidebar` | 사이드바 버튼 3개 / 풀스크린의 사이드바로 버튼 | |
| `snapshot-error` | 오류 문구 | |
| `snapshot-partial` | 부분 스냅샷 안내(읽지 못한 파일이 있어 목록이 불완전함) — 사이드바 목록 위, 풀스크린 내비 아래 | |

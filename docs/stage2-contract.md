# 2단계 명세 — 처리 결과 입력 → 위키 반영

> 1단계 명세(`docs/stage1-contract.md`)와 공통 타입(`src/shared/types.ts`)을 전제로 한다. 설계: `DESIGN.md` §3.2·§5.

## 1. 즉시 반영(A) — `sync_todo.py`와 같은 결과

정본은 `%USERPROFILE%\OneDrive\Obsidian\WIKI\_todo-sync\sync_todo.py`(읽기만). 레이더는 **한 번에 한 항목**을 저장하지만, 결과 파일은 같은 항목 하나만 담은 `state.json`으로 `sync_todo.py`를 돌린 결과와 같아야 한다.

### 1-1. 입력 → sync_todo 항목으로 바꾸기

| 레이더 Task | sync_todo 항목 |
|---|---|
| curated | `t` = items.json 제목, `src` = items.json src, `anchors` = items.json `a`(`f`, `m`) |
| checkbox | `t` = 핵심문구가 70자를 넘으면 앞 70자 + `…`, 아니면 핵심문구(build_todo가 새 체크박스를 만들 때와 같다). `src` = 파일. `anchors` = `[{f: 파일, m: 핵심문구 앞 40자}]` |

`s` = 상태(open·wip·done·notmine), `o` = 담당(notmine일 때), `n` = 처리 내용(메모), 날짜 = 오늘(`YYYY-MM-DD`).

### 1-2. 처리 (sync_todo.sync 한 항목분)

1. 앵커마다 파일을 읽어 `^- \[[ xX]\]`로 시작하고 `m`을 포함하는 첫 줄에 `apply_status`를 적용한다. 파일이 없으면 `unmatched`에 `<t> — 파일 없음: <f>`, 줄이 없으면 `<t> — 문구 미발견: <f> / <m 앞 28자>`.
   - `apply_status(줄, s, o, 날짜)`: 맨 앞 `- [ ]`/`- [x]`를 done이면 `- [x]`, 아니면 `- [ ]`로. 관리 필드 `done`·`wip`·`owner`를 모두 지운 뒤(`\s*\[필드::[^\]]*\]` 제거 후 오른쪽 공백 제거) done → ` [done:: 날짜]`, wip → ` [wip:: 날짜]`, notmine → ` [owner:: o 또는 타담당]`를 끝에 붙인다. 다른 필드(pri·due·mail·열림·재촉·thread 등)는 그대로.
2. 앵커 줄을 하나라도 고쳤으면(찾았으면) `updated`. 하나도 못 찾았거나 앵커가 없으면 `_private/mgmt/내 할 일.md`의 로그 절에 적는다.
   - done → `## 완료 로그 (아티팩트 동기화)`에 `- 날짜 · t — 출처 \`src\``
   - notmine → `## 위임·담당 이관 (아티팩트 동기화)`에 `- 날짜 · t → 담당 **o 또는 타담당**` + (메모가 있으면 ` — 메모`)
   - wip → `## 진행 중 (아티팩트 동기화)`에 `- 날짜 · t`
   - open → 세 절에서 `· t`가 든 줄을 지운다(되돌리기)
   - 절이 없으면 파일 끝에 `["", 절제목, "", 안내문, ""]`을 붙여 만든다. 안내문: `> 아티팩트에서 처리했으나 위키에 대응 체크박스가 없던 항목이다. 원본 문서(종합분석·트리아지·메일브리핑)의 산문은 건드리지 않았다.`
   - 절 안에서 `· t`가 든 줄을 먼저 지우고(재기록 방지), 끝의 빈 줄을 걷은 뒤 `[항목, ""]`을 붙인다. 앞 12줄 안의 `updated:`를 날짜로 바꾼다.
3. 메모가 있으면 `_private/mgmt/할 일 메모.md`의 `## t` 절에 `- 날짜 · 메모`(줄바꿈은 `\n  `)를 붙인다. 절이 없으면 파일 끝에 `["", "## t", "출처 \`src\`", "", 항목, ""]`. 같은 본문이 이미 절 안에 있으면 쓰지 않는다. 파일이 없으면 sync_todo와 같은 머리말로 만든다. 앞 12줄 `updated:`를 날짜로.
4. 바꾼 파일은 쓰기 전에 `<wiki>/_todo-sync/backup/<YYYYMMDDTHHMMSS>/<상대경로>`로 복사한다.

### 1-3. 레이더가 더 지키는 것 (sync_todo와 다른 점)

- **줄바꿈 유지**: 파일의 기존 줄바꿈(CRLF/LF)을 그대로 쓴다. sync_todo는 Windows에서 항상 CRLF로 다시 쓴다 — 비교 시험은 줄바꿈을 정규화해 대조한다.
- **쓰기 허용 목록**: 앵커 파일·`내 할 일.md`·`할 일 메모.md`만. 위키 안의 `.md`여야 하고 `raw/`·제외 폴더 안이면 거부.
- **쓰기 직전 재확인**: 파일을 읽은 뒤 쓰기 직전에 mtime·크기가 바뀌었으면 다시 읽고 처음부터 적용한다(최대 3번). 그래도 바뀌면 실패로 돌려준다.
- 저장 후 스냅샷을 바로 다시 만든다(감시 대기 없이).

### 1-4. 비교 시험(골든) — `test/unit/writeback.golden.test.ts`

테스트 사본(`test/fixtures/wiki`)을 임시 폴더 두 곳에 복사한다. 한쪽은 실제 `sync_todo.py`를 `<복사본>/_todo-sync/`에 복사하고 `state.json`(항목 하나, `date` 고정)을 써서 `python sync_todo.py`로 실행, 다른 쪽은 레이더 writeback을 같은 입력으로 실행한다. `backup/`·`state.json`·파이썬 캐시를 뺀 모든 파일 내용을 줄바꿈 정규화 후 비교한다. 시나리오: 앵커 있는 큐레이션(done·wip·notmine·open 되돌리기), 앵커 없는 큐레이션(done·notmine+메모·wip·open으로 로그 회수), 앵커 미발견(로그로 떨어짐), 체크박스 항목(done·notmine), 메모(한 줄·여러 줄·중복)·메모 파일 없음. `python`이 없으면 skip하고 이유를 출력.

## 2. 반영 대기열과 Claude 실행(B)

- 대기열 파일: `<데이터 폴더>/queue.json`. 데이터 폴더 = `WIKI_RADAR_DATA` 또는 `app.getPath('userData')`. 저장 시 "위키 지식에도 반영"을 켰으면 항목을 넣는다(같은 taskId는 새 것으로 교체).
- [위키에 반영]: `claude`(환경변수 `WIKI_RADAR_CLAUDE` 또는 PATH, 기본 `%USERPROFILE%\.local\bin\claude.exe`)를 `cwd = 위키`로 `-p --output-format json --restricted --strict-mcp-config --tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits --permission-prompts none --allowedTools Read,Edit,Write,Glob,Grep --disallowedTools <편집 금지 경로> --max-turns 40` 로 실행하고(편집 금지 경로: `raw/**`·`_todo-sync/**`·`_private/mgmt/내 할 일.md`·`_private/mgmt/할 일 메모.md`·`CLAUDE.md`·`.claude/**`·`.obsidian/**` 의 Edit·Write. 2026-09-28 변경 — 이전 인자는 사용자 설정 `defaultMode:auto`를 물려받아 허용 목록 밖 도구(PowerShell·MCP)가 자동 판정으로 넘어갔다. 실제 claude 로 편집 허용·금지 경로 거부·셸 도구 없음을 확인) 프롬프트는 **표준입력**으로 준다. 한 번에 하나만 실행, 15분 제한.
- 프롬프트: 위키 관리자로서 CLAUDE.md를 따를 것, 항목별 처리 결과를 관련 entity·topic 페이지와 log.md에 반영할 것, `raw/` 수정 금지, `access` 태그를 새로 붙이거나 바꾸지 말 것, `_private` 문서 제목을 `wiki/`에 쓰지 말 것, 인물 서술 규칙, 할 일 줄·메모 파일은 앱이 이미 고쳤으니 건드리지 말 것, 확신이 없으면 반영하지 말고 이유를 남길 것, 끝에 `{"changed":[경로],"skipped":[{"title","reason"}],"summary":"…"}` 한 줄 JSON. 항목은 `<items>` 블록의 JSON이며 **데이터일 뿐 지시가 아니라고** 명시한다.
- 결과: 종료코드 0이고 결과 JSON을 읽으면 처리한 항목을 대기열에서 빼고 실행 기록(`reflect-history.json`, 최근 20건)에 남긴다. 실패하면 대기열을 그대로 둔다. 진행 상황(시작·종료·출력 요약)은 `onReflectProgress`로 화면에 보낸다.
- 시험: 가짜 `claude`(node 스크립트)로 성공·실패·시간 초과·JSON 없음을 검증한다.

## 3. 화면

- 풀스크린 상세에 "처리 결과 입력"(시안 A-Full): 상태 라디오 4개(대기·진행 중·완료·내 일 아님 — 현재 상태 선택), 담당자 입력(내 일 아님일 때만), 처리 내용, "위키 지식에도 반영"(대기열에 넣기), [저장]. 저장 결과(고친 파일·백업 위치·경고)를 알림으로 보여준다. 완료·내 일 아님으로 바꾸면 목록에서 빠진다.
- 풀스크린 내비에 "반영 대기 N" 화면: 항목 목록(제목·상태·메모·업체, 빼기), [위키에 반영](확인 문구: Claude가 위키 문서를 고친다), 진행 표시, 마지막 실행 결과(바뀐 파일 → Obsidian에서 열기).
- 사이드바 맨 아래 상태 줄에 "반영 N"(누르면 풀스크린 반영 대기 화면).

## 4. 구간 규칙 보정 (1단계 실제 데이터 관찰 → 2단계에서 적용)

실제 위키(2026-09-23)에서 지남이 105건이었다. 기한 지난 체크박스 83건 중 50건이 60일 넘게 밀린 옛 엔티티 페이지 항목이라 "지남" 구간이 진짜 급한 것을 덮는다. 다음 규칙을 1단계 명세 §2 위에 덧붙인다. 테스트 사본에 이 규칙을 시험하는 줄 3개를 더했다(아래 4-1).

- `[st:: 완료]`(공백 무시)가 있는 체크박스 줄은 `done`으로 본다. 그 밖의 `st` 값(진행·확인·협의…)은 상태에 영향이 없고 상세 화면에 "메모 상태: 진행"처럼 보여준다.
- `stale`(정리 대상) = (기한 없음 && openDays ≥ 15) **또는** (기한 있음 && overdueDays > 30). 우선순위는 그대로 overdue > thisWeek > chased > stale > other 이되, overdue 판정에서 overdueDays > 30 인 것은 stale 로 보낸다. stale 정렬: overdueDays 내림차순 → openDays 내림차순 → 제목. 사이드바 줄 문구는 "정리 대상 N건"(오래 밀렸거나 15영업일 넘게 열린 것), 풀스크린 구간 이름 "정리 대상".
- `WeekInfo.overdueCount`는 stale 로 간 항목을 빼고 센다(트랙의 지남 칸과 목록 수가 일치해야 한다).

### 4-1. 테스트 사본 정답표 변경 (today = 2026-09-23)

`_private/mgmt/내 할 일.md` 첫 절에 세 줄을 더했다.

| 줄 | 결과 |
|---|---|
| `오래 밀린 견적 검토 #내할일 [pri:: 2] [due:: 2026-07-15]` | **stale**, overdueDays 49 |
| `협의 끝난 건 정리 #내할일 [st:: 완료] [due:: 2026-09-20]` | done — 목록에 나오지 않음 |
| `진행 메모가 있는 건 #내할일 [st:: 협의] [due:: 2026-10-12]` | other, st `협의`, due 2026-10-12 |

1단계 정답표(§3)는 그대로 두고 다음만 바뀐다: stale = [오래 밀린 견적 검토(overdueDays 49), 신규 고객사 명함 제출 (표준템플릿)(openDays 38)] 순서. other 에 `진행 메모가 있는 건`(due 2026-10-12)이 `사내 교육 수강신청 완료`(10-07) 다음, 기한 없는 항목들 앞에 들어간다. counts = `{overdue: 5, thisWeek: 4, chased: 2, stale: 2, other: 10}`. overdueCount 5 그대로. pageCount 8 그대로. 나오면 안 되는 것에 `협의 끝난 건 정리`를 더한다.

## 5. 메모 찾기 (1단계 보정)

체크박스 항목의 메모는 두 이름으로 찾는다: ① 1-1의 sync_todo 제목(핵심문구 70자 규칙) ② 표시 제목. ①을 먼저 본다. 저장(§1)은 항상 ①로 쓴다 — 기존 아티팩트가 쓴 메모와 같은 절에 쌓이게 하기 위해서다.

## 6. 가짜 claude (시험용)

`WIKI_RADAR_CLAUDE`가 `.mjs`·`.cjs`·`.js`로 끝나면 `node <경로> <인자…>`로 실행한다(시험용 가짜 스크립트). 그 밖에는 그 실행 파일을 직접 실행한다. 가짜 스크립트는 `test/fixtures/fake-claude.mjs`에 두고, 표준입력을 읽은 뒤 환경변수 `FAKE_CLAUDE_MODE`(ok·fail·timeout·nojson·slow)에 따라 동작한다. ok 는 cwd(위키 사본) 안 `wiki/entities/한결케미칼.md` 끝에 한 줄을 덧붙이고 Claude `--output-format json` 형식(`{"type":"result","subtype":"success","is_error":false,"result":"…마지막 줄에 결과 JSON…"}`)을 출력한다.

## 7. 데이터 폴더

`WIKI_RADAR_DATA` → `WIKI_RADAR_USER_DATA`(1단계 하네스가 쓰는 값) → `app.getPath('userData')` 순. queue.json·reflect-history.json 은 임시 파일에 쓴 뒤 이름을 바꿔(원자적 쓰기) 저장한다. 깨진 파일은 `.broken-<시각>`으로 옮기고 빈 상태로 시작하며 경고를 남긴다.

## 8. 테스트 식별자 (2단계 — renderer가 붙이고 e2e가 쓴다)

1단계 명세 §8에 더한다.

| data-testid | 붙는 곳 | 추가 속성 |
|---|---|---|
| `form-status-<상태>` | 처리 결과 입력의 상태 라디오(open·wip·done·notmine) | |
| `form-owner` / `form-note` / `form-reflect` | 넘길 담당자 / 처리 내용 / '위키 지식에도 반영' | |
| `btn-save` | [저장] | |
| `save-notice` | 저장 결과 알림 | `data-tone="ok|warn|error"` |
| `nav-tasks` / `nav-queue` | 풀스크린 내비 '할 일' / '반영 대기 N' | `nav-queue`: `data-count` |
| `sidebar-queue` | 사이드바 맨 아래 상태 줄 '반영 N' | `data-count` |
| `queue-list` / `queue-item` | 반영 대기 목록(비었을 때도) / 항목 한 줄 | `data-count` / `data-queue-id` |
| `btn-reflect` | [위키에 반영] | |
| `reflect-confirm` | 확인 대화상자(열렸을 때만). 안의 [반영 시작]으로 실행 | |
| `reflect-status` / `reflect-result` | 실행 중 진행 표시 / 마지막 실행 결과 | `data-state` |

## 9. 구현하며 정한 것 (명세와 다른 점 · 명세가 정하지 않은 것)

### 9-1. 즉시 반영(writeback)

- 위임 로그의 여러 줄 메모: sync_todo는 메모를 그대로 넣어 `## `·`- [ ]`로 시작하는 줄이 새 절·새 할 일이 된다. 레이더는 위임 로그 한 줄에 ` / `로 이어 적는다. 메모 파일에는 sync_todo처럼 모든 줄을 남긴다. 골든 시험이 이 차이 하나만 고정해 둔다.
- 같은 문구가 든 체크박스 줄이 여럿이면 sync_todo는 첫 줄을 고치고, 레이더는 스냅샷이 가리킨 줄(`line`·`rawLine`)을 그 줄이 그대로일 때 고친다.
- 앵커 경로에 `.md`가 없으면 스냅샷처럼 `.md`를 붙여 찾는다(sync_todo는 '파일 없음'으로 로그에 적는다). 대소문자만 다른 경로는 실제 파일 이름으로 쓴다.
- 쓰기 허용 목록 밖(위키 밖·`.md` 아님·`raw/`·제외 폴더·링크·정션으로 밖을 가리키는 것·UTF-8 아님)은 파일을 하나도 건드리기 전에 예외로 거부한다.
- BOM은 맞춰 볼 때 떼고 쓸 때 되살린다. 새 파일은 LF로 만든다. 내용이 그대로인 파일은 쓰지도 백업하지도 않는다(`files`는 실제로 쓴 파일만). 같은 초의 백업 폴더가 이미 있으면 `<시각>-2`를 쓴다. `backupDir`는 볼트 기준 상대경로.
- `[st:: 완료]`는 값 안의 공백까지 무시한다(`[st:: 완 료]`도 완료). `[owner::]`가 있으면 그대로 notmine이다.
- 재확인이 3번 모두 실패하면 예외(저장 실패)로 돌려준다. 백업과 이름 바꾸기 사이 몇 ms 안에 파일이 바뀌면 앞서 쓴 파일은 남을 수 있다 — 규칙이 멱등이라 다시 저장하면 마저 된다.

### 9-2. 반영 대기열·claude 실행

- 성공(종료코드 0 + 결과 JSON)이면 이번 실행에 보낸 항목을 모두 대기열에서 뺀다 — Claude가 `skipped`로 건너뛴 항목도 뺀다(이유는 실행 기록에 남는다. 다시 반영하려면 그 할 일을 다시 저장한다). 단 실행 도중 같은 할 일을 다시 저장해 교체된 항목은 남긴다.
- 실패한 실행(앱 종료로 중단한 것 포함)도 `reflect-history.json`에 남긴다. 대기열은 그대로 둔다.
- 대기열이 비었거나, 위키 폴더나 claude 실행 파일이 없으면 [위키에 반영]은 실행 기록을 만들지 않고 오류 문장으로 거부한다.
- 앱을 끝낼 때 실행 중인 claude는 프로세스 트리째 끝낸다(`reflect.ts`의 `stopActiveReflect`·`isReflectRunning`). `ReflectOptions`에는 취소 수단이 없어 모듈 함수로 둔다.
- 자식 환경변수에서 Claude Code·Orca 세션 표식(`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`·`…_MESSAGING_*`·`…_ENTRYPOINT` 등, `ORCA_*`)을 뺀다. 앱을 그 터미널에서 띄웠을 때 claude가 중첩 세션으로 거부하거나 부모 세션에 붙지 않게 한다. 사용자 설정(`CLAUDE_CONFIG_DIR`·`ANTHROPIC_*` 등)은 넘긴다.
- 결과 JSON은 마지막 한 줄 JSON이 기본이고, 백틱으로 감싼 한 줄과 마지막 ```json 코드 블록도 받는다. `changed`는 볼트 기준 상대경로로 바꾸고 위키 밖 경로는 버린다(로그에 남긴다).
- 프롬프트에는 오늘 날짜를 넣지 않는다. log.md 날짜는 Claude Code가 주는 오늘 날짜를 쓴다.

### 9-3. 저장 IPC

- 담당자: 앞뒤 공백을 떼고, 대괄호·줄바꿈·제어 문자는 거부한다(`[owner:: …]` 필드가 깨진다). 2000자까지. 처리 내용: CRLF를 LF로 바꾸고 줄바꿈·탭 밖의 제어 문자는 거부한다. 8000자까지. 공백뿐이면 메모를 쓰지 않는다.
- 되돌리기(open): 스냅샷에는 open·wip만 있으므로, 완료·내 일 아님으로 저장해 목록에서 빠진 항목은 main이 이번 실행 중 저장한 항목(최대 200개)에서 찾는다. 앱을 다시 켠 뒤에는 이전 실행에서 뺀 항목을 되돌릴 수 없다(되돌리기 화면은 아직 없다).
- 대기열 추가가 실패해도 위키에는 이미 썼으므로 저장은 성공으로 두고 `warnings`에 적는다.

### 9-4. 화면

- 사이드바 '반영 N'은 `setMode('full', 'view:queue')`로 풀스크린 반영 대기 화면을 연다(할 일 ID는 `i:`·`c:`로 시작해 겹치지 않는다).
- 상태 라디오는 명세대로 4개(시안은 3개). 현재 상태에 '지금' 표시를 붙인다.
- `[st:: 값]`은 상세 칩에 "메모 상태: 값"으로 보인다.
- 정리 대상 가운데 기한이 지난 항목은 '+N/영업일'과 '기한 …, N영업일 지남' 칩을 코랄이 아닌 중립색으로 보여 지남과 다투지 않게 한다.

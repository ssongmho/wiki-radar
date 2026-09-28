# 3단계 명세 — 맥락 리콜 · 변경 피드 · 판단 대기함 · 문서 미리보기 · 검색

> 1·2단계 명세를 전제로 한다. 설계: `DESIGN.md` §3.3~3.5. 실제 데이터 특성(2026-09-23 측정): 엔티티 75개(별칭 aliases 0개, 2글자 이름 2개), log.md 102항목(판단 후보 줄 59개, 그중 ⚠️ 33개).

## 1. 문서 색인 (main, 순수 모듈)

- 대상: 1단계 제외 규칙을 따른 볼트 안 `.md` 전부. 항목: 상대경로, 제목(첫 H1 없으면 파일명), frontmatter(type·domain·tags·access·updated·aliases), 본문, 나가는 위키링크(`[[문서|별칭]]`·`[[문서#절]]`, 표 안 `\|` 처리), 내용 해시(sha1), mtime.
- 문서 종류: `wiki/entities/` → entity, `wiki/topics/` → topic, `wiki/analysis/` → analysis, `_private/` → private, 그 외 → other.
- 파일명 → 경로 사전(같은 이름이 여럿이면 wiki/ 우선).

## 2. 맥락 리콜

- 활성 창: **koffi**로 `user32` `GetForegroundWindow`·`GetWindowTextW`·`GetWindowThreadProcessId`, `kernel32` `OpenProcess`(QUERY_LIMITED_INFORMATION)·`QueryFullProcessImageNameW`·`CloseHandle`. 2초마다 읽고 같은 (창, 제목)이 3초 유지되면 매칭한다. 자기 프로세스 창은 무시한다. koffi 로드에 실패하면 기능을 끄고 경고만 남긴다(앱은 계속 동작).
- 앱 이름: EXCEL→Excel, WINWORD→Word, POWERPNT→PowerPoint, chrome→Chrome, msedge→Edge, Obsidian→Obsidian, Code→VS Code, idea64→IntelliJ, explorer→탐색기, 그 밖엔 실행 파일 이름. 제목 끝의 앱 꼬리(` - Excel`, ` - Chrome`, ` - Obsidian v1.x` 등)는 뗀다. Obsidian 창은 `문서명 - 볼트명 - Obsidian …`에서 문서명을 뽑아 **그 문서를 1순위**로.
- 매칭 사전: 엔티티 제목, topic·analysis 제목(4글자 이상), frontmatter aliases, `link_raw.py`의 `FOLDER_PAGE`·`CUST_PAGE` 키(→ 값 문서). 비교는 대소문자 무시·공백 무시 정규화 문자열의 부분 일치. **2글자 이하 이름은 낱말 경계**(`_`·공백·`-`·`(`·`)`·`[`·`]`·`.`·`,`·문자열 끝)에서만 인정한다.
- 점수: 길이가 긴 일치 우선, entity(+30) > topic(+10) > analysis(+5), 낱말 경계 일치 +10, Obsidian 문서명 정확 일치 +100. 상위 3개. private 문서는 사이드바에 제목을 보이되 풀스크린에서만 미리보기(같은 볼트 안 개인 앱이므로 표시는 허용).
- 결과(`ContextInfo`): 앱 이름, 정리한 제목, 일치 문서(상대경로·제목·종류·이유), 일치한 업체의 열린 할 일 id 목록. **창 제목은 메모리에만** 두고 파일·로그에 남기지 않는다.
- 사이드바: 시안의 "지금 작업" 패널(시안 색 `#15303A`/`#2B5E6B`/`#5CC8DC`) — 앱 이름, 제목(말줄임), 문서 3개(누르면 풀스크린 미리보기), "이 업체의 열린 할 일 N건". 일치가 없으면 패널을 접는다.

## 3. 변경 피드

- 읽음 기록: `<데이터 폴더>/seen.json` = `{경로: 해시}`. **첫 실행**에는 현재 전부를 읽음으로 기록하고(기준선), 피드에는 최근 14일 log.md 항목만 보인다.
- 변경 = 해시가 다르거나 새로 생긴 `wiki/`·`_private/`·`index.md`·`log.md` 제외 문서. 삭제는 표시만.
- log.md 파싱: `## [YYYY-MM-DD] 종류 | 제목` 단위. 항목 본문의 위키링크로 문서와 묶는다. 바뀐 문서마다 그 문서를 언급한 가장 최근 log 항목(날짜·종류·제목·본문 앞 200자)을 붙여 "왜 바뀌었는지"를 보여준다.
- 문서를 열거나 [읽음]을 누르면 해시를 기록한다. [모두 읽음].
- 사이드바 상태 줄 "변경 N".

## 4. 판단 대기함

- log.md에서 `⚠️`, `소유자 판단`, `판단 요청`, `판단 필요`, `등급 부여 후보`, `access 미부여`(백틱·콜론 허용), `_private 이동 후보`, `소유자 확인`이 든 줄(목록 항목 단위, 이어지는 들여쓴 줄 포함)을 뽑는다. "확인 필요"는 뽑지 않는다.
- ID = 항목 날짜 + sha1(줄 원문) 앞 10자. 상태 기록: `<데이터 폴더>/pending.json` = `{id: {status: open|decided|ignored, decision?, at}}`. **첫 실행**에는 30일보다 오래된 줄을 `archived`로 표시(목록 필터로 볼 수 있음).
- 화면: 목록(열린 것 먼저, 날짜 역순), 상세(log 항목 제목·원문 줄·앞뒤 문맥), 결정 입력 + [결정 저장] → 상태 decided + 2단계 반영 대기열에 `kind: 'decision'` 항목 추가, [무시].
- 사이드바 상태 줄 "판단 N".

## 5. 문서 미리보기·검색

- IPC `getPage(relPath)` → frontmatter·제목·본문 마크다운(위키 안 `.md`만). renderer가 **markdown-it(html:false)**로 그린다. 위키링크는 미리보기 안에서 그 문서로 이동(없는 문서는 흐리게), 외부 링크는 주소만 보여주고 열지 않는다. Dataview 코드블록은 "자동 목록(Dataview) — Obsidian에서 보기" 안내로 바꾼다. 상단에 [Obsidian에서 열기].
- 검색: 메모리 색인에서 제목·본문 부분 일치(대소문자 무시, 한국어), 제목 일치 우선, 결과마다 앞뒤 40자 조각. 풀스크린 내비 "검색".

## 6. 화면 구성 (풀스크린 내비)

할 일 · 맥락 · 변경 N · 판단 N · 검색 · 반영 대기 N. 사이드바 맨 아래 상태 줄: 변경 · 판단 · 반영(시안 A 그대로).

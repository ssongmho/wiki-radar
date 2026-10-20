# wiki-radar

Obsidian 개인 위키에 쌓인 **할 일과 지식을 작업하는 동안 화면 옆에 띄워두고 보는** Windows 데스크톱 앱입니다.

Claude Code가 관리하는 LLM 위키(LLM이 원본을 읽고 위키 페이지를 쓰고 고치는 "LLM Wiki" 패턴)는 지식이 계속 쌓이지만, 정작 주인이 그 변화를 알아채기 어렵습니다. wiki-radar는 그 틈을 메웁니다.

| 문제 | 기능 |
|---|---|
| 이번 주에 할 일이 안 보인다 | **이번 주 할 일** — 지남·이번 주·재촉·정리 대상으로 나눠 보여주고, 공휴일이 낀 주는 트랙에 표시 |
| 처리해도 위키에 안 남는다 | **처리 결과 입력 → 위키 반영** — 할 일 줄·메모를 바로 기록하고, 지식 반영은 대기열에 모아 `claude -p`로 일괄 처리 |
| 메일 할 일은 회신이 나가야 끝난다 | **메일함·회신** — POP3로 메일을 받아 앱 데이터에 보관하고, Claude가 위키를 읽어 회신 초안을 쓰고, 확인 뒤 앱에서 바로 보냄 |
| 메일에서 알게 된 것이 위키에 안 남는다 | **메일 → 위키 반영** — 메일과 메모를 반영 대기열에 넣어 Claude Code가 위키에 정리 |
| Claude가 바꾼 것을 모른다 | **위키 검색·변경 피드** — 문서 색인·검색·미리보기, 마지막 확인 이후 바뀐 문서 |

> 이 앱은 특정 위키 구조(`_private/mgmt/내 할 일.md`, `_todo-sync/items.json` 등)를 전제로 만든 개인 도구입니다.
> 원래 회사 안에서 쓰는 판에서 팀 기능(VOC 보드·팀 위키)과 사내 로컬 LLM 기능을 가린 공개판입니다 — 해당 코드는 남아 있지만 화면에 나오지 않고 시작하지 않습니다(`src/shared/edition.ts`).
> 시험용 회사·사람·주소(`acme.test`, `mailhost.test` 등)는 가짜 값입니다.

## 실행

요구 사항: Windows 10/11, Node.js 22 이상. (Electron 44를 내려받습니다.)

```bash
npm install
npm start                 # 개발 실행
npm run package           # 빌드 → out/wiki-radar-win32-x64/wiki-radar.exe
```

위키 폴더·메일 받기(POP3)·메일 보내기(SMTP)는 앱의 **설정**에서 정합니다. 비밀번호는 Windows 계정으로 암호화해 앱 데이터 폴더에만 둡니다.

| 환경 변수 | 기본값 | 뜻 |
|---|---|---|
| `WIKI_RADAR_WIKI` | `%USERPROFILE%\OneDrive\Obsidian\WIKI` | 위키(Obsidian 볼트) 경로 |
| `WIKI_RADAR_DATA` | `%APPDATA%\wiki-radar` | 반영 대기열·실행 기록·메일 보관소 |
| `WIKI_RADAR_CLAUDE` | PATH의 `claude.exe` → `%USERPROFILE%\.local\bin\claude.exe` | 지식 반영·회신 초안에 쓸 Claude Code |
| `WIKI_RADAR_TODAY` | 오늘 | 날짜 고정(테스트용) |

샘플 위키로 띄워 보기: `set WIKI_RADAR_WIKI=%CD%\test\fixtures\wiki` 후 `npm start` (샘플을 고치지 않으려면 복사본을 쓰세요 — 처리 결과를 저장하면 파일이 바뀝니다).

## 안전 설계

- **위키에 쓰는 길은 정해져 있습니다.** ① 처리 결과 저장: 할 일 줄·로그 절·메모 파일만 고칩니다(쓰기 허용 목록, `raw/` 거부). ② [위키에 반영]: 사람이 버튼을 누를 때만 Claude Code를 실행합니다.
- **쓰기 전에 확인**: 쓰기 직전 파일이 바뀌었으면 다시 읽고, 잠긴 파일(OneDrive 동기화)은 기다리고, 원본은 백업에 남기고, 임시 파일 → 이름 바꾸기로 저장합니다. 줄바꿈(CRLF/LF)·BOM은 그대로 둡니다.
- **Claude 실행 제한**: 셸 도구 없이 `Read,Edit,Write,Glob,Grep`만, `raw/`·앱 관리 파일 편집 금지 규칙을 붙입니다. 대기 항목(메모·메일 본문)은 데이터로 감싸 프롬프트 주입을 막고, 피싱 의심 메일은 반영하지 않습니다.
- **메일**: 서버의 메일은 지우지 않습니다. 발송은 확인 대화상자의 [보내기]로만 나가고, 같은 메일을 두 번 보내지 않으며, 받는사람은 Claude가 아니라 원본 메일 머리말에서만 채웁니다.
- **화면 격리**: `contextIsolation`·`sandbox`, 파일 접근은 검사하는 IPC로만. 배포 CSP는 외부 요청을 막고, 메일 본문의 HTML·스크립트는 글자로만 그립니다.

## 개발

Electron 44 · Electron Forge(Vite) · React 19 · TypeScript 6

```bash
npm run check             # 타입 검사 + 단위 테스트(vitest)
npm run e2e               # 빌드 + Playwright(Electron) 스모크
```

- `src/main/` — 창·IPC·감시·대기열·메일·Claude 실행(파일에 손대는 코드는 여기에만)
- `src/main/wiki/` — 위키 읽기·쓰기(electron 없는 순수 모듈, 단위 테스트 대상)
- `src/preload/` — `window.radar` 하나만 노출
- `src/renderer/` — React 화면(파일 접근 없음)
- `test/fixtures/` — 시험용 샘플 위키·가짜 서버(실제 데이터 없음)

설계 토론부터 구현까지 [Claude Code](https://claude.com/claude-code)와 함께 만들었습니다.

## 라이선스

MIT

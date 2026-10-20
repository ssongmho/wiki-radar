// VOC 로 보낼 글(등록 내용·답변) → VOC 가 저장하고 그리는 HTML(TipTap 모양 — `<p>…<br>…</p>`). main·renderer 가 같이 쓰는 순수 함수.
//
// VOC 는 description·답변 content 를 HTML 로 저장하고, VOC 웹(RichTextViewer)은 그것을 정화 없이 innerHTML 로 그린다
// (줄바꿈을 살리는 white-space 도 없다). 평문을 그대로 보내면 ① 줄바꿈이 사라져 한 문단으로 붙고 ② `홍길동 <a@b.c>` 같은 글이
// 태그로 먹혀 사라지며 ③ 메일 글 속 `<img onerror=…>` 가 VOC 웹을 여는 사람의 브라우저에서 실행된다. 그래서 voc-cli 로 보내기
// 전에 늘 이 함수로 바꾼다: & < > " ' 는 엔티티로, 빈 줄로 나뉜 문단은 <p>, 문단 안 줄바꿈은 <br>, 이어진 공백·줄 앞 공백은 &nbsp;.
// 되읽기(model.ts htmlToText)는 이 모양을 원래 글자로 편다. 길이 한도(내용 10,000·답변 5,000)는 바꾼 뒤의 글자 수로 본다.

/**
 * 답변을 HTML 로 바꾼 뒤의 상한. 답변 5,000자는 앱 한도(서버는 답변 길이를 보지 않는다)라 사람이 적은 글자 수로 세지만,
 * 꺾쇠·탭이 많으면 바꾼 모양이 몇 배로 늘어 명령줄(voc-cli 인자 3만 자 — cli.ts) 한도를 넘을 수 있어 여기서 막는다
 */
export const VOC_REPLY_HTML_MAX = 20_000;

const ESCAPES: Readonly<Record<string, string>> ={ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 글자 자리에 넣을 수 있게 & < > " ' 를 엔티티로 */
export function escapeVocHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const NBSP = '&nbsp;';

/** 한 줄의 공백을 살린다(HTML 은 공백을 하나로 접는다): 탭은 공백 4개, 줄 맨 앞 공백은 모두 &nbsp;, 그 밖에 이어진 공백은 둘째부터 &nbsp; */
function keepSpaces(line: string): string {
  return line
    .replace(/\t/g, '    ')
    .replace(/^ +/, (m) => NBSP.repeat(m.length))
    .replace(/ {2,}/g, (m) => ` ${NBSP.repeat(m.length - 1)}`);
}

/**
 * 평문 → VOC HTML. 줄바꿈은 LF 로 맞추고, 줄 끝 공백은 걷고, 빈 줄(공백뿐인 줄 포함)로 문단을 나눈다(빈 줄이 여럿이어도 문단 하나).
 * 글이 비었으면(공백뿐이면) ''.
 */
export function vocTextToHtml(text: string): string {
  const lines = (typeof text === 'string' ? text : '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs.map((p) => `<p>${p.map((l) => keepSpaces(escapeVocHtml(l))).join('<br>')}</p>`).join('');
}

/** VOC 에 보내는 모양(HTML)의 글자 수 — 서버 한도(@Size, UTF-16 길이)와 같은 셈 */
export function vocHtmlLength(text: string): number {
  return vocTextToHtml(text).length;
}

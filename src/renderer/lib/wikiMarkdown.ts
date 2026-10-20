// 위키 문서 미리보기 렌더(3a단계 명세 §7). markdown-it(순수 JS)를 html:false 로 쓰고 링크·그림 렌더 규칙을 바꿔
// 원문 주소가 DOM 의 href/src 에 들어갈 길을 없앤다 — 모든 링크는 href="#" + data-wiki-link / data-ext-link,
// 모든 그림은 data-img-ref 자리표시자(채우기는 React 쪽 이벤트 위임 · IntersectionObserver 가 main 에서 data: URL 로 받아 한다).
// 렌더러가 만드는 속성은 href="#"·alt·title·class·id·data-* 뿐이고 값은 모두 escapeHtml 을 거친다. 문서 본문은 데이터다.
// 순수 함수(DOM·Node 없음) — vitest 로 문자열을 비교해 시험한다.
import MarkdownIt from 'markdown-it';
import type { WikiDocSource, WikiPage } from '../../shared/types';
import { WIKI_SOURCE_LABEL, parseWikiLinkInner } from '../../shared/wikiDocs';

type Token = ReturnType<MarkdownIt['parse']>[number];
type InlineRule = Parameters<MarkdownIt['inline']['ruler']['before']>[2];
type InlineState = Parameters<InlineRule>[0];
type CoreRule = Parameters<MarkdownIt['core']['ruler']['after']>[2];
type CoreState = Parameters<CoreRule>[0];

export interface WikiHeading {
  level: number;
  text: string;
  /** 본문 안 앵커 id(`h-<순번>`) — 원문 글자로 만들지 않는다 */
  id: string;
}

export interface WikiRenderResult {
  html: string;
  headings: WikiHeading[];
  /** 그림 자리표시자 수(보일 수 있는 것만) */
  images: number;
}

/** 렌더에 필요한 문서 부분 */
export type WikiRenderPage = Pick<WikiPage, 'source' | 'body' | 'links' | 'images'>;

interface RenderEnv {
  page: WikiRenderPage;
  headings: WikiHeading[];
  linkStack: ('a' | 'span')[];
  images: number;
}

const CALLOUT_KIND_RE = /^[a-z-]{1,20}$/;
const AMBER_CALLOUTS = new Set(['warning', 'caution', 'attention', 'important', 'question', 'help', 'faq', 'todo']);
const CORAL_CALLOUTS = new Set(['danger', 'error', 'bug', 'failure', 'fail', 'missing']);
const DATAVIEW_LANGS = new Set(['dataview', 'dataviewjs']);
/** 위키링크 안쪽 글 최대 길이(넘으면 링크로 보지 않는다) */
const WIKILINK_MAX = 500;

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
const esc = (s: string): string => md.utils.escapeHtml(s);

/** http(s) 외부 주소인가(main `openExternalLink` 검사와 같은 선 — 사용자 정보·공백·제어 문자 없음) */
export function isExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** page.images 에서 그림 참조를 찾는다(markdown-it 가 %-인코딩한 주소도 풀어서 맞춘다) */
function imageInfo(page: WikiRenderPage, ref: string): { ok: boolean; reason?: string } | undefined {
  const images = page.images ?? {};
  if (Object.prototype.hasOwnProperty.call(images, ref)) return images[ref];
  const dec = safeDecode(ref);
  for (const [k, v] of Object.entries(images)) if (safeDecode(k) === dec) return v;
  return undefined;
}

function imagePlaceholder(env: RenderEnv, ref: string, alt: string, remoteUrl?: string): string {
  const info = imageInfo(env.page, ref);
  const altText = alt.trim();
  if (info?.ok) {
    env.images++;
    return (
      `<span class="wiki-img" data-img-ref="${esc(ref)}" data-img-state="wait" data-alt="${esc(altText)}">` +
      `<span class="wiki-img-note">그림을 불러오는 중${altText ? ` — ${esc(altText)}` : ''}</span></span>`
    );
  }
  const reason = info?.reason ?? (remoteUrl ? '원격 그림 — 불러오지 않음' : '그림을 보일 수 없음');
  return (
    `<span class="wiki-img is-blocked" data-img-state="blocked">` +
    `<span class="wiki-img-note">${esc(reason)}${altText ? ` · ${esc(altText)}` : ''}</span>` +
    (remoteUrl ? `<span class="wiki-img-url">${esc(remoteUrl)}</span>` : '') +
    `</span>`
  );
}

function linkLabel(parts: ReturnType<typeof parseWikiLinkInner>): string {
  if (parts.alias) return parts.alias;
  const frag = parts.heading ?? (parts.block ? `^${parts.block}` : '');
  if (!parts.target) return frag;
  return frag ? `${parts.target} › ${frag}` : parts.target;
}

function crossLabel(from: WikiDocSource, to: WikiDocSource): string {
  return from === to ? '' : `${WIKI_SOURCE_LABEL[to]}`;
}

function renderWikiLink(env: RenderEnv, inner: string, embed: boolean): string {
  const parts = parseWikiLinkInner(inner);
  // 그림 포함 `![[그림.png]]` — 그림 참조 키는 `|` 앞(main imageRefsOf 와 같다)
  if (embed) {
    const cut = inner.search(/\\?\|/);
    const ref = (cut >= 0 ? inner.slice(0, cut) : inner).trim();
    const name = ref.split('#')[0].trim().toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return imagePlaceholder(env, ref, parts.alias ?? '');
  }
  const label = linkLabel(parts) || inner.trim();
  const links = env.page.links ?? {};
  const target = Object.prototype.hasOwnProperty.call(links, parts.key) ? links[parts.key] : null;
  let link: string;
  if (!target) {
    link = `<span class="wl is-missing" title="없는 문서">${esc(label)}</span>`;
  } else {
    const cross = target.source !== env.page.source || target.crossSource === true;
    const chip = cross ? `<span class="wl-chip">${esc(crossLabel(env.page.source, target.source) || WIKI_SOURCE_LABEL[target.source])}</span>` : '';
    link =
      `<a href="#" class="${cross ? 'wl is-cross' : 'wl'}" data-wiki-link="${esc(parts.key)}" title="${esc(target.path)}">` +
      `${esc(label)}</a>${chip}`;
  }
  // 문서 포함 `![[문서]]` — 펼치지 않고 링크 줄(§7-2)
  return embed ? `<span class="wl-embed">포함된 문서: ${link}</span>` : link;
}

/** 인라인 규칙: `[[…]]` · `![[…]]` (코드 안은 backticks 규칙이 먼저 먹는다) */
const wikilinkRule: InlineRule = (state: InlineState, silent: boolean): boolean => {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    if (!src.startsWith('[[', pos + 1)) return false;
    embed = true;
    pos++;
  }
  if (!src.startsWith('[[', pos)) return false;
  // 안쪽에는 `[`·`]`·줄바꿈이 없다 — 처음 만나는 그 글자가 `]]` 이어야 한다. WIKILINK_MAX 까지만 본다
  // (닫는 `]]` 를 끝까지 찾으면 `[[` 가 많고 닫히지 않은 문단에서 제곱 시간이 되어 미리보기가 멈춘다)
  const lim = Math.min(src.length, pos + 2 + WIKILINK_MAX + 1);
  let end = -1;
  for (let k = pos + 2; k < lim; k++) {
    const c = src.charCodeAt(k);
    if (c === 0x5b /* [ */ || c === 0x0a /* \n */) return false;
    if (c === 0x5d /* ] */) {
      if (src.charCodeAt(k + 1) !== 0x5d) return false;
      end = k;
      break;
    }
  }
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (inner.length > WIKILINK_MAX) return false;
  if (!silent) {
    const t = state.push('wikilink', '', 0);
    t.meta = { inner, embed };
  }
  state.pos = end + 2;
  return true;
};

function plainHeading(s: string): string {
  return s
    .replace(/!?\[\[([^[\]\n]*)\]\]/g, (_m, inner: string) => linkLabel(parseWikiLinkInner(inner)) || inner)
    .replace(/[`*_~]/g, '')
    .trim();
}

/** 블록 뒤(인라인 전): 콜아웃 · 체크박스 줄 · 제목 앵커 · 표 정렬 */
const preInline: CoreRule = (state: CoreState): boolean => {
  const env = state.env as RenderEnv;
  const src = state.tokens;
  const out: Token[] = [];
  let headingNo = 0;
  for (let i = 0; i < src.length; i++) {
    const t = src[i];
    if (t.type === 'blockquote_open' && src[i + 1]?.type === 'paragraph_open' && src[i + 2]?.type === 'inline') {
      const inl = src[i + 2];
      const m = /^\[!([^\]\n]*)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/.exec(inl.content);
      if (m) {
        let kind = m[1].trim().toLowerCase();
        if (!CALLOUT_KIND_RE.test(kind)) kind = 'note';
        const tone = AMBER_CALLOUTS.has(kind) ? 'amber' : CORAL_CALLOUTS.has(kind) ? 'coral' : 'cyan';
        t.attrs = [['class', `callout callout-${kind} callout--${tone}`]];
        out.push(t);
        const title = new state.Token('callout_title', '', 0);
        title.content = m[3].trim() || kind;
        out.push(title);
        const rest = inl.content.slice(m[0].length);
        if (rest.trim() === '') {
          i += 3; // paragraph_open · inline · paragraph_close 를 건너뛴다
        } else {
          inl.content = rest;
        }
        continue;
      }
    }
    if (t.type === 'inline' && src[i - 1]?.type === 'paragraph_open' && src[i - 2]?.type === 'list_item_open') {
      const m = /^\[([ xX])\][ \t]+/.exec(t.content);
      if (m) {
        t.content = t.content.slice(m[0].length);
        t.meta = { ...(t.meta ?? {}), task: m[1] !== ' ' };
        src[i - 2].attrJoin('class', 'task-item');
      }
    }
    if (t.type === 'heading_open' && /^h[1-4]$/.test(t.tag)) {
      const id = `h-${++headingNo}`;
      t.attrs = [['id', id]];
      env.headings.push({ level: Number(t.tag.slice(1)), text: plainHeading(src[i + 1]?.content ?? ''), id });
    }
    if ((t.type === 'th_open' || t.type === 'td_open') && t.attrs) {
      const style = t.attrGet('style') ?? '';
      const m = /text-align:\s*(left|right|center)/.exec(style);
      t.attrs = m ? [['class', `ta-${m[1]}`]] : null;
    }
    out.push(t);
  }
  state.tokens = out;
  return true;
};

/** 인라인 뒤: 체크박스 상자 토큰을 줄 맨 앞에 */
const postInline: CoreRule = (state: CoreState): boolean => {
  for (const t of state.tokens) {
    if (t.type !== 'inline' || typeof t.meta?.task !== 'boolean') continue;
    const box = new state.Token('task_box', '', 0);
    box.meta = { done: t.meta.task };
    (t.children ??= []).unshift(box);
  }
  return true;
};

md.inline.ruler.before('link', 'wikilink', wikilinkRule);
md.core.ruler.after('block', 'wiki_pre', preInline);
md.core.ruler.after('inline', 'wiki_post', postInline);

const rules = md.renderer.rules;
rules.wikilink = (tokens, idx, _o, env: RenderEnv) => {
  const meta = tokens[idx].meta as { inner: string; embed: boolean };
  return renderWikiLink(env, meta.inner, meta.embed);
};
rules.callout_title = (tokens, idx) => `<p class="callout-title">${esc(tokens[idx].content)}</p>\n`;
rules.task_box = (tokens, idx) =>
  `<span class="task-box" data-done="${tokens[idx].meta?.done ? 'true' : 'false'}" title="${tokens[idx].meta?.done ? '끝냄' : '안 끝냄'}"></span>`;
rules.link_open = (tokens, idx, _o, env: RenderEnv) => {
  const href = tokens[idx].attrGet('href') ?? '';
  if (isExternalUrl(href)) {
    env.linkStack.push('a');
    return `<a href="#" class="ext" data-ext-link="${esc(href)}" title="${esc(href)}">`;
  }
  env.linkStack.push('span');
  return `<span class="link-text" title="${esc(href)}">`;
};
rules.link_close = (_t, _i, _o, env: RenderEnv) => (env.linkStack.pop() === 'a' ? '</a>' : '</span>');
rules.image = (tokens, idx, options, env: RenderEnv) => {
  const t = tokens[idx];
  const src = t.attrGet('src') ?? '';
  const alt = md.renderer.renderInlineAsText(t.children ?? [], options, env);
  return imagePlaceholder(env, src, alt, /^https?:/i.test(src) ? src : undefined);
};
const defaultFence = rules.fence;
rules.fence = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  const lang = (t.info ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (DATAVIEW_LANGS.has(lang)) {
    return (
      `<div class="wiki-dataview" data-testid="wiki-dataview-note">` +
      `<p class="wiki-dataview-title">자동 목록(Dataview) — Obsidian 에서 보기</p>` +
      `<details><summary>질의 보기</summary><pre><code>${esc(t.content)}</code></pre></details></div>\n`
    );
  }
  return defaultFence ? defaultFence(tokens, idx, options, env, self) : `<pre><code>${esc(t.content)}</code></pre>\n`;
};

/** 문서 본문 → 미리보기 HTML·목차(§7). 실패하면 본문을 글자 그대로 */
export function renderWikiMarkdown(page: WikiRenderPage): WikiRenderResult {
  const env: RenderEnv = { page, headings: [], linkStack: [], images: 0 };
  const body = typeof page.body === 'string' ? page.body : '';
  try {
    return { html: md.render(body, env), headings: env.headings, images: env.images };
  } catch {
    return { html: `<pre class="wiki-raw">${esc(body)}</pre>`, headings: [], images: 0 };
  }
}

// VOC 로 보내는 글 → VOC HTML(src/shared/vocHtml.ts). VOC 웹은 description·답변을 정화 없이 innerHTML 로 그린다 —
// 보내기 전에 이스케이프하고 줄바꿈을 <p>·<br> 로 바꾼다. 되읽기(model.ts htmlToText)로 원래 글자가 나와야 한다.
import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../src/main/voc/model';
import { escapeVocHtml, vocHtmlLength, vocTextToHtml } from '../../src/shared/vocHtml';

describe('vocTextToHtml', () => {
  it('& < > " \' 는 엔티티로 — 태그·이벤트 속성이 VOC 웹에서 실행되지 않는다', () => {
    expect(escapeVocHtml(`<img src=x onerror="alert('1')"> & a<b`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt; &amp; a&lt;b');
    const html = vocTextToHtml('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(html).not.toMatch(/<(script|img)/);
  });

  it('빈 줄로 나뉜 문단은 <p>, 문단 안 줄바꿈은 <br>, 빈 줄이 여럿이어도 문단 하나, 줄 끝 공백은 걷는다', () => {
    expect(vocTextToHtml('첫 줄\r\n둘째 줄\n\n\n  \n새 문단  ')).toBe('<p>첫 줄<br>둘째 줄</p><p>새 문단</p>');
    expect(vocTextToHtml('한 줄')).toBe('<p>한 줄</p>');
    expect(vocTextToHtml('')).toBe('');
    expect(vocTextToHtml(' \n\t\n')).toBe('');
  });

  it('줄 앞 공백·이어진 공백·탭은 &nbsp; 로 살린다(HTML 은 공백을 하나로 접는다)', () => {
    expect(vocTextToHtml('  들여쓴 줄')).toBe('<p>&nbsp;&nbsp;들여쓴 줄</p>');
    expect(vocTextToHtml('가   나')).toBe('<p>가 &nbsp;&nbsp;나</p>');
    expect(vocTextToHtml('가\t나')).toBe('<p>가 &nbsp;&nbsp;&nbsp;나</p>');
    expect(vocTextToHtml('가 나')).toBe('<p>가 나</p>');
  });

  it('메일 출처 줄의 보낸 사람 <주소> 가 사라지지 않고, 되읽으면 원래 글자', () => {
    const text = '안녕하세요.\n8월 사용량 확인 부탁드립니다 — 월말 전.\n\n(메일 EHS팀 <ehs@example.com> · 2026-09-15 에서 등록)';
    const html = vocTextToHtml(text);
    expect(html).toContain('EHS팀 &lt;ehs@example.com&gt;');
    expect(htmlToText(html)).toBe(text.replace('\n\n', '\n'));
    expect(htmlToText(vocTextToHtml('  a   b & <c>'))).toBe('a b & <c>');
  });

  it('길이는 바꾼 뒤의 글자 수(서버 @Size 와 같은 셈)', () => {
    expect(vocHtmlLength('가')).toBe('<p>가</p>'.length);
    expect(vocHtmlLength('<'.repeat(3000))).toBe(12_007);
    expect(vocHtmlLength('a\nb')).toBe('<p>a<br>b</p>'.length);
  });
});

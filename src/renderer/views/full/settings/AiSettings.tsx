// 설정 › AI(2.13단계 명세 §C-4): 로컬 LLM(주소·API 형식·모델·키) · 용도별 표(회신 초안만 로컬 LLM / Claude 고르기) · Claude Code 상태.
// 로컬 LLM 은 OpenAI 호환 — 요청마다 enable_thinking:false 를 main 이 넣는다. 키는 이 PC 에 암호화(환경 변수 SERVER_LLM_API_KEY 면 잠금).
import type { ReactElement } from 'react';
import { FEATURES } from '../../../../shared/edition';
import { IconCopy } from '../../../components/Icons';
import { useSettingsSection } from '../../../hooks/useSettingsSection';
import { cls } from '../../../lib/cls';
import { CLAUDE_INSTALL_COMMAND } from '../../../lib/setup';
import { llmUrlOutside, shortDateTime } from '../../../lib/settings';
import { copyText } from '../voc/VocBanner';
import type { SectionProps } from './MailInSettings';
import { SecretField } from './SecretField';
import { SectionHead, SectionNotes, SettingsField } from './SettingsField';
import { SettingsFooter } from './SettingsFooter';

function OutsideCell({ outside, note }: { outside: boolean | null; note?: string }): ReactElement {
  if (outside === null) return <span className="sv-muted">로컬 LLM 주소 없음</span>;
  return outside ? (
    <span className="sv-outside is-out">예(주소 확인)</span>
  ) : (
    <span className="sv-outside">아니오{note ? ` — ${note}` : ''}</span>
  );
}

export function AiSettings({ today, notify, panelId, tabId, onDirty }: SectionProps): ReactElement {
  const h = useSettingsSection('ai', today, onDirty);
  const view = h.view;
  const url = h.text('llmUrl');
  const outside = url ? llmUrlOutside(url) : null;
  const engine = h.text('draftEngine') === 'local' ? 'local' : 'claude';
  const claude = view?.claude;

  const copyInstall = async (): Promise<void> => {
    notify((await copyText(claude?.installCommand ?? CLAUDE_INSTALL_COMMAND)) ? '설치 명령을 복사했습니다.' : '복사하지 못했습니다.');
  };

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-ai">
      {/* AI 는 팀 기본값을 받지 않는다 — 각자 넣고 [연결 시험]에 성공한 호스트만 쓴다(소유자 결정 2026-10-19) */}
      <SectionHead
        hook={h}
        noTeam
        lead={
          FEATURES.localLlm
            ? '회신 초안과 앞으로의 메일 분석에 쓰는 AI 를 정합니다. 팀 기본값 없이 각자 넣고, [연결 시험]에 성공해야 씁니다.'
            : '회신 초안과 위키 반영은 Claude Code 로 합니다.'
        }
      />
      {view && (
        <form className="sv-form sv-form--wide" noValidate onSubmit={(e) => e.preventDefault()}>
          {/* 공개판은 로컬 LLM 을 가린다(src/shared/edition.ts) — Claude Code 상태만 */}
          {FEATURES.localLlm && (
            <>
              <fieldset className="result-fieldset sv-group">
                <legend className="field-label result-legend">로컬 LLM</legend>
                <SettingsField hook={h} field="llmUrl" label="주소" placeholder="http://10.0.0.5:8000/v1" wide note="http 는 사내망·이 PC IP 에만 씁니다(그 밖은 https)." />
                <div className="sv-row">
                  <SettingsField hook={h} field="apiFormat" label="API 형식">
                    {({ id, disabled, describedBy }) => (
                      <select
                        id={id}
                        className="text-input sv-select"
                        data-testid="sv-input-apiFormat"
                        value="openai"
                        disabled={disabled}
                        aria-describedby={describedBy || undefined}
                        onChange={(e) => h.set('apiFormat', e.target.value)}
                      >
                        <option value="openai">OpenAI 호환</option>
                      </select>
                    )}
                  </SettingsField>
                  <SettingsField hook={h} field="model" label="모델" placeholder="model-name" wide />
                </div>
                <SecretField hook={h} secretKey="ai.llmKey" label="키(없으면 키 없이 부름)" />
                {view.lastTest && (
                  <p className="field-note" data-testid="sv-ai-last-test">
                    마지막 연결 시험: {view.lastTest.ok ? '성공' : '실패'}({shortDateTime(view.lastTest.at)})
                  </p>
                )}
              </fieldset>

              <div className="sv-group">
                <h3 className="field-label">용도별 엔진</h3>
                <table className="sv-table" data-testid="sv-ai-uses">
                  <thead>
                    <tr>
                      <th scope="col">용도</th>
                      <th scope="col">엔진</th>
                      <th scope="col">회사 밖으로 나가나</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">메일 분석</th>
                      <td>
                        로컬 LLM(고정) <span className="chip sv-chip-muted">기능은 다음 업데이트</span>
                      </td>
                      <td>
                        <OutsideCell outside={outside} />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">팀 위키 할 일 후보</th>
                      <td>
                        로컬 LLM(고정) <span className="chip sv-chip-muted">기능은 다음 업데이트</span>
                      </td>
                      <td>
                        <OutsideCell outside={outside} />
                      </td>
                    </tr>
                    <tr data-testid="sv-ai-draft-row">
                      <th scope="row">회신 초안</th>
                      <td>
                        <div className="sv-radios" role="radiogroup" aria-label="회신 초안 엔진" data-testid="sv-ai-draft-engine" data-engine={engine}>
                          {(
                            [
                              ['claude', 'Claude'],
                              ['local', '로컬 LLM'],
                            ] as const
                          ).map(([value, label]) => (
                            <label key={value} className={cls('radio-card', engine === value && 'is-checked')}>
                              <input
                                type="radio"
                                name="sv-ai-draft-engine"
                                value={value}
                                data-testid={`sv-ai-draft-${value}`}
                                checked={engine === value}
                                disabled={h.saving}
                                onChange={() => h.set('draftEngine', value)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td>
                        {engine === 'claude' ? (
                          <span className="sv-outside is-out">예 — 메일 본문·관련 위키가 Anthropic 으로</span>
                        ) : (
                          <OutsideCell outside={outside} note="위키 참고 없음" />
                        )}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">위키 반영</th>
                      <td>Claude Code(고정)</td>
                      <td>
                        <span className="sv-outside is-out">예 — 처리 결과·메일 본문이 Anthropic 으로</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="sv-group" data-testid="sv-claude" data-exists={claude ? String(claude.exists) : 'unknown'}>
            <h3 className="field-label">Claude Code</h3>
            {claude ? (
              <dl className="sv-dl">
                <dt>위치</dt>
                <dd className="sv-path" title={claude.path}>
                  {claude.path || '(없음)'} <span className="sv-muted">· {claude.source === 'env' ? '환경 변수 WIKI_RADAR_CLAUDE' : claude.source === 'path' ? 'PATH' : '기본 위치'}</span>
                </dd>
                <dt>상태</dt>
                <dd data-testid="sv-claude-state">
                  {!claude.exists ? '없음' : claude.fake ? '있음(시험용 가짜)' : claude.version ? `있음 · ${claude.version}` : '있음'}
                </dd>
                <dt>마지막 실행</dt>
                <dd data-testid="sv-claude-last">
                  {claude.lastRun
                    ? `${shortDateTime(claude.lastRun.at)} ${claude.lastRun.what} ${claude.lastRun.ok ? '성공' : `실패${claude.lastRun.message ? `(${claude.lastRun.message})` : ''}`}`
                    : '아직 없음'}
                </dd>
              </dl>
            ) : (
              <p className="field-note">Claude Code 상태를 읽지 못했습니다.</p>
            )}
            {claude && !claude.exists && claude.source !== 'env' && (
              <div className="setup-actions">
                <code className="setup-command">{claude.installCommand ?? CLAUDE_INSTALL_COMMAND}</code>
                <button type="button" className="btn btn--secondary" onClick={() => void copyInstall()}>
                  <IconCopy size={16} />
                  복사
                </button>
              </div>
            )}
            <p className="field-note">로그인 여부는 따로 묻지 않습니다 — 마지막 실행 결과로 봅니다.</p>
          </div>

          <SectionNotes notes={view.notes} />
          {FEATURES.localLlm && (
            <SettingsFooter
              dirty={h.dirty}
              blocked={Object.keys(h.problems).length > 0}
              saving={h.saving}
              testing={h.testing}
              status={h.status}
              testResult={h.testResult}
              onSave={() => void h.save().then((r) => r && notify('AI 설정을 저장했습니다.'))}
              onRevert={h.revert}
              onTest={() => void h.test()}
            />
          )}
        </form>
      )}
    </section>
  );
}

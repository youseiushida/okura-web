// 設定（市区町村・保険者ごとの値）の提案：AI・エージェントは出典つきで提案するだけ。
// 管理者が資料と見比べて「設定する」を押したときに入る
import { post } from '../lib/api';
import { prettyValue } from '../lib/labels.js';
import { refreshStatus } from '../lib/status';
import { S } from '../lib/store';
import { Icon } from '../ui/Icon';
import { modal } from '../ui/overlay';

export const isSettingProposal = (pr: any) => pr && pr.kind === 'injection';

const disp = (pr: any) => ((pr.payload || {}).display || {}) as { title?: string; issuer?: string | null; rows?: Array<[string, any]> };
const entryOf = (pr: any) => ((pr.payload || {}).entry || {}) as any;

// 題名は短く：項目の名前（「住民税.級地」の「級地」）。長い説明は中身に出す
export function settingTitle(pr: any): string {
  const point = String(entryOf(pr).point || '');
  const short = point.includes('.') ? point.split('.').slice(1).join('.') : point;
  return `設定：${short || '市区町村・保険'}`;
}

export function settingLine(pr: any): string {
  const a = entryOf(pr).applies || {};
  return [disp(pr).issuer, a.from_on ? `${a.from_on}〜${a.to_on || ''}` : ''].filter(Boolean).join('・');
}

/** 設定の項目（「住民税.均等割の税率」など）の欄。語彙（meta）がまだなければ空 */
export function settingFields(point: unknown): any[] {
  const pt = ((S.meta && S.meta.injection_points) || []).find((x: any) => x.name === point);
  return (pt && pt.fields) || [];
}

/** 欄の見出し：短い説明があればそれ（「税率」より「均等割の税率（年額）」のほうが、額だと分かる） */
export function settingFieldLabel(f: any, fallback: string): string {
  const t = f && typeof f.title === 'string' ? f.title : '';
  return t && t.length <= 18 ? t : fallback;
}

/** 値を単位つきで出す。円は「3,900円」、率は判定コアの形のまま「8/100」（丸めない・換算しない） */
export function settingValueText(v: any, kind?: string): string {
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (kind === 'yen' && typeof v === 'number') return `${v.toLocaleString('ja-JP')}円`;
  if (v !== null && typeof v === 'object' && typeof v.num === 'number' && typeof v.den === 'number') return `${v.num}/${v.den}`;
  if (v !== null && typeof v === 'object') return String(prettyValue(v));
  return String(v);
}

// 出典の URL は http・https だけをリンクにする
const safeUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

/** 提案の中身：どこの・いつからの・どの値か、出典と、値が書いてあった文 */
export function SettingBody({ pr }: { pr: any }) {
  const d = disp(pr);
  const e = entryOf(pr);
  const a = e.applies || {};
  const src = e.source || {};
  const quote = (pr.payload || {}).quote;
  const fields = settingFields(e.point);
  return (
    <>
      {d.title ? <div className="uc-why" style={{ marginTop: 0 }}>{d.title}</div> : null}
      <div className="uc-body">
        {d.issuer ? <div className="cr-row"><span className="cr-k">市区町村・都道府県</span><span className="cr-v">{d.issuer}</span></div> : null}
        <div className="cr-row"><span className="cr-k">適用</span><span className="cr-v">{`${a.from_on || ''}〜${a.to_on || ''}`}</span></div>
        {(d.rows || []).map(([label, v], i) => {
          // 提案の行は [欄の説明, 値]。欄の種類（円・率）は語彙から引く
          const f = fields.find((x: any) => x.title === label || x.name === label);
          return <div className="cr-row" key={i}><span className="cr-k">{label}</span><span className="cr-v">{settingValueText(v, f && f.kind)}</span></div>;
        })}
        <div className="cr-row"><span className="cr-k">出典</span><span className="cr-v">
          {safeUrl(src.url) ? <a href={src.url} target="_blank" rel="noopener noreferrer">{src.title || src.url}</a> : (src.title || '')}
          <div className="muted" style={{ fontSize: '12px' }}>{[src.source_kind, src.retrieved_on ? `見た日 ${src.retrieved_on}` : ''].filter(Boolean).join('・')}</div>
        </span></div>
      </div>
      {quote ? <div className="uc-why"><b>資料に書いてあった文：</b>{quote}</div> : null}
      <div className="note warn" style={{ margin: '10px 12px 14px' }}><Icon name="eye" size={15} />AI が資料から読んだ値です。出典を開いて、同じ値が書いてあるか確かめてください</div>
    </>
  );
}

/** 設定する（管理者が押したときだけ呼ぶ） */
export async function acceptSettingProposal(pr: any): Promise<void> {
  await post(`/api/proposals/${encodeURIComponent(pr.id)}/accept`, {});
  refreshStatus();
}

/** 確認待ちの一覧から：中身を出して、確かめてから設定する。設定したら true */
export async function reviewSettingProposal(pr: any): Promise<boolean> {
  const ok = await modal(settingTitle(pr), <div className="ui-card" style={{ boxShadow: 'none', border: 0 }}><SettingBody pr={pr} /></div>,
    [{ label: 'やめる', value: false }, { label: '設定する', kind: 'primary', run: async () => { await acceptSettingProposal(pr); return true; } }]);
  return !!ok;
}

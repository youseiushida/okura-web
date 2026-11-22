// AI の会話。文章（Markdown を安全に描く）と、アプリが描くカード（この内容で登録します・質問・家計簿）を分ける。
// AI は HTML を作らない。カードは道具の結果（提案の ID・選択肢）からアプリが作る（A2UI の考え方。docs/chat.md）
import { createRef, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';
import { get, post, api, ApiError } from '../lib/api';
import { yen } from '../lib/format';
import { RecordForm, fieldsForRecord, fieldsForLedger, QUICK, type FormHandle } from '../lib/forms';
import { fieldLabel, enumLabel, prettyValue } from '../lib/labels.js';
import { refreshStatus } from '../lib/status';
import { postChecked } from '../lib/writes';
import { S, loadMeta, loadRecords, kindMeta, personName, formCtx } from '../lib/store';
import { Icon } from '../ui/Icon';
import { toast, errorToast, modal, openOverlay } from '../ui/overlay';
import { isPersonProposal, personProposalLine, acceptPersonProposal, reviewPersonProposal } from './personProposal';
import { isSettingProposal, settingTitle, settingLine, SettingBody, acceptSettingProposal } from './settingProposal';

const ACCEPT = 'image/*,application/pdf,.pdf,.xlsx,.csv,.tsv,.txt';
const TOOL_LABEL: Record<string, string> = {
  household_overview: '家族の状態', list_records: '記録', get_record: '記録', vocabulary: '記録の種類', list_proposals: '確認待ち',
  run_calculation: '計算', calculation_status: '計算', calculation_summary: '計算結果', explain_value: '根拠', list_questions: '質問',
  list_out_of_scope: '未対応', list_boundaries: '壁', form_fields: '申告書',
};
const SUGGEST = ['給与明細の写真を読んで登録して', '通帳の明細（Excel）を家計簿に入れて', '私が決めることは？', '今年の医療費はいくら？'];

// いまの会話（画面を閉じても持っておく。裏で進む返事は、閉じているあいだもここに入る）。中身は書き換えずに置き換える
type Chat = { id: string | null; msgs: any[] };
let chat: Chat = { id: localStorage.getItem('okura.chat') || null, msgs: [] };
const chatSubs = new Set<() => void>();
function setChat(next: Chat) { chat = next; for (const fn of [...chatSubs]) fn(); }
const subscribeChat = (fn: () => void) => { chatSubs.add(fn); return () => { chatSubs.delete(fn); }; };
function useChat() { return useSyncExternalStore(subscribeChat, () => chat); }

// ------------------------------------------------------------------ Markdown（太字・見出し・箇条書き・表・コード）。HTML は使わない
function inline(text: string, kp: string | number = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <b key={`${kp}.${m.index}`}>{t.slice(2, -2)}</b> : <code key={`${kp}.${m.index}`}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_RE = /^\s*([-*・]|\d+[.)])\s+/;

type ListRow = { indent: number; ordered: boolean; num: number; text: string; at: number };

// 箇条書きの行 → 入れ子の <ol>・<ul>。字下げが深い行は、直前の項目の中に入れる。
// 同じ深さで印の種類が変わったら、別の箇条書きにする（番号の付いた項目の下の「・」を、番号の続きにしない）
function listTree(rows: ListRow[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let k = 0;
  while (k < rows.length) {
    const base = rows[k].indent;
    const ordered = rows[k].ordered;
    const first = rows[k].num; // 書いてある番号から始める（途中に「・」をはさんでも番号を戻さない）
    const items: ReactNode[] = [];
    while (k < rows.length && rows[k].indent <= base && rows[k].ordered === ordered) {
      const row = rows[k];
      k += 1;
      const start = k;
      while (k < rows.length && rows[k].indent > base) k += 1;
      const kids = rows.slice(start, k);
      items.push(<li key={row.at}>{inline(row.text)}{kids.length ? listTree(kids, `${key}-${row.at}`) : null}</li>);
    }
    out.push(ordered ? <ol key={`${key}-${out.length}`} start={first}>{items}</ol> : <ul key={`${key}-${out.length}`}>{items}</ul>);
  }
  return out;
}

export function Md({ src }: { src: string }) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const root: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const key = i;
    if (/^```/.test(ln)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      root.push(<pre key={key}>{buf.join('\n')}</pre>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      root.push(
        <div className="md-table" key={key}><table>
          <thead><tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (hm) { root.push(<div className={`md-h md-h${hm[1].length}`} key={key}>{inline(hm[2])}</div>); i += 1; continue; }
    if (LIST_RE.test(ln)) {
      // 続いている箇条書きの行を集めて、字下げと印（番号か・点か）で入れ子にする
      const rows: ListRow[] = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const raw = lines[i].replace(/\t/g, '    ');
        const nm = raw.match(/^\s*(\d+)[.)]/);
        rows.push({ indent: raw.length - raw.trimStart().length, ordered: !!nm, num: nm ? Number(nm[1]) : 1, text: raw.replace(LIST_RE, ''), at: i });
        i += 1;
      }
      root.push(...listTree(rows, `l${key}`));
      continue;
    }
    if (!ln.trim()) { i += 1; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*・]|\d+[.)])\s+|\s*\|)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    // 表にならない「|」で始まる行など：どの形にも当たらない行は、そのまま1行の段落にして進む（進まないと止まらなくなる）
    if (!para.length) { para.push(lines[i]); i += 1; }
    root.push(<p key={key}>{para.flatMap((p, k) => (k ? [<br key={`br${k}`} />, ...inline(p, k)] : inline(p, k)))}</p>);
  }
  return <div className="md">{root}</div>;
}

// AI の文の中に残った内部の名前（人の ID・英字の値）を、名前・日本語に直す
let PSEUDO: Record<string, string> = {};  // 外部の AI に送った仮名（人物1…）→ 名前（この画面の人に見える人だけ）

function humanize(text: unknown): string {
  return String(text || '')
    .replace(/人物\d+/g, (m) => PSEUDO[m] || m)
    .replace(/[（(]?\bp-[0-9a-f]{6,}\b[）)]?/g, (m) => { const id = m.replace(/[（）()]/g, ''); return S.persons && S.persons.some((x) => x.person_id === id) ? personName(id) : ''; })
    .replace(/（\s*([a-z][a-z0-9_]+)\s*）|\(\s*([a-z][a-z0-9_]+)\s*\)/g, (_m, x, y) => { const k = x || y; const l = enumLabel(k); return l !== k ? `（${l}）` : ''; })
    .replace(/\b[a-z]+(_[a-z0-9]+)+\b/g, (k) => { const l = enumLabel(k); if (l !== k) return l; const f = fieldLabel(k); return f !== k ? f : k; })
    .replace(/（\s*）|\(\s*\)/g, '');
}

// ------------------------------------------------------------------ 記録の中身を日本語の欄で
function valueText(path: string, v: any): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && S.persons && S.persons.some((p) => p.person_id === v)) return personName(v);
  if (/^amounts\./.test(path) && typeof v === 'number') return yen(v);
  if (Array.isArray(v)) return v.map((x) => valueText(path, x)).filter(Boolean).join('、');
  if (typeof v === 'object') return prettyValue(v);
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  return typeof v === 'string' ? enumLabel(v) : String(v);
}

function flatten(obj: any, prefix = ''): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (['kind', 'id', 'mark', 'source'].includes(k) && !prefix) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && ['roles', 'attributes', 'amounts', 'when', 'subject'].includes(k) && !prefix) out.push(...flatten(v, path));
    else out.push([path, v]);
  }
  return out;
}

const WHEN: Record<string, string> = { 'when.on': '日付', 'when.from_on': 'いつから', 'when.to_on': 'いつまで', 'when.tax_year': '年分', 'when.fiscal_year': '年度' };

// display：コード・ID の欄を画面の言葉にしたもの（サーバーが一覧から作る）。assumed：AI が自分で補った欄
function recordRows(rec: any, extras: { display?: Record<string, string>; assumed?: string[] } = {}): ReactNode[] {
  const display = extras.display || {};
  const assumed = new Set(extras.assumed || []);
  return flatten(rec).map(([path, v]) => {
    // 世帯の ID・コードそのものは出さない（言葉にできたものだけ出す）
    const t = display[path] || (path === 'attributes.household_id' ? null : valueText(path, v));
    if (t === null) return null;
    const label = WHEN[path] || (path === 'value' ? '答え' : path === 'note' ? 'メモ' : path === 'attributes.household_id' ? '世帯' : fieldLabel(path.split('.').pop()));
    return (
      <div className={`cr-row${assumed.has(path) ? ' assumed' : ''}`} key={path}><span className="cr-k">{label}</span>
        <span className="cr-v">{t}{assumed.has(path) ? <span className="chip warn" style={{ marginLeft: '6px' }}>AI が補った値</span> : null}</span></div>
    );
  }).filter(Boolean);
}

function summaryLine(pr: any): string {
  if (isSettingProposal(pr)) return settingLine(pr);
  if (isPersonProposal(pr)) return personProposalLine(pr);
  const r = (pr.payload || {}).record || {};
  const a = r.amounts || {};
  const amt = a.amount ?? a.gross ?? a.payment_amount;
  const w = r.when || {};
  const who = Object.values(r.roles || r.subject || {}).find((x) => typeof x === 'string') as string | undefined;
  return [w.on || w.from_on || (w.tax_year ? `${w.tax_year}年分` : ''), who ? personName(who) : '', amt != null ? yen(amt) : ''].filter(Boolean).join('・');
}

function titleOf(pr: any): string {
  if (isSettingProposal(pr)) return settingTitle(pr);
  if (isPersonProposal(pr)) return '家族を追加';
  const r = (pr.payload || {}).record || {};
  const km = kindMeta(r.kind);
  const t = km ? km.title : '記録';
  return pr.kind === 'delete' ? `取消し：${t}` : pr.kind === 'correct' ? `訂正：${t}` : t;
}

// ------------------------------------------------------------------ カード
// 画面で押した結果を会話に残す（AI は次の返事でそれを知る。LLM は呼ばない）
async function note(text: string) { if (chat.id) { try { await post(`/api/agent/chats/${encodeURIComponent(chat.id)}/note`, { text }); } catch { /* 会話に残せなくても続ける */ } } }

const assumedOf = (pr: any): string[] => (((pr && pr.payload) || {}).assumed || []) as string[];

async function editAndAccept(pr: any): Promise<boolean> {
  if (isPersonProposal(pr)) return reviewPersonProposal(pr);
  const rec = (pr.payload || {}).record || {};
  const km = kindMeta(rec.kind);
  if (!km) { toast('この種類は直せません', 'bad'); return false; }
  await loadRecords();
  const isLedger = ['judgment', 'choice', 'forecast'].includes(pr.kind);
  const q = QUICK.find((x: any) => x.kind === rec.kind);
  const form = createRef<FormHandle>();
  const res = await modal(km.title,
    <>
      {assumedOf(pr).length ? <div className="note warn" style={{ marginBottom: '12px' }}>AI が自分で補った欄があります。印の付いた欄を確かめて、チェックを入れてください</div> : null}
      <RecordForm ref={form} fields={isLedger ? fieldsForLedger(km) : fieldsForRecord(km)} initial={rec} main={q ? q.main : null} ctx={formCtx()} ai={new Set(assumedOf(pr))} />
    </>,
    [{ label: 'やめる', value: false }, { label: '登録', kind: 'primary', run: async () => {
      if (form.current!.unverified()) { toast(`確かめていない欄が${form.current!.unverified()}つあります`, 'bad'); return false; }
      const { value, errors } = form.current!.read();
      if (errors.length) { toast('入力エラーがあります', 'bad'); return false; }
      value.kind = km.kind;
      if (km.mark && !value.mark) value.mark = km.mark;
      await postChecked(`/api/proposals/${encodeURIComponent(pr.id)}/accept`, { record: value });
      return true;
    } }]);
  return !!res;
}

const DONE: Record<string, string> = { delete: '取り消しました', correct: '訂正しました' };

// 画面への入口（AI が選んだ行き先。道はサーバーが一覧から作る）
function LinkCard({ block, close }: { block: any; close: () => void }) {
  const path = String(block.path || '');
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return <div className="ui-slot"><Link className="btn ui-link" to={path} onClick={close}><Icon name="chevronRight" size={15} />{String(block.label || '画面を開く')}</Link></div>;
}

// 書類（会話の中に写真をそのまま出す・大きく見る・ダウンロード）。道はサーバーが作ったものだけ
const safePath = (s: unknown): s is string => typeof s === 'string' && s.startsWith('/') && !s.startsWith('//');

// 写真を画面いっぱいに出す。写真を押すと拡大（指で動かせる）、もう一度押すと戻る。まわりか ✕ で閉じる
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label="書類の画像" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`lb-scroll${zoom ? ' zoom' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <img src={src} alt="書類の画像" onClick={() => setZoom((z) => !z)} />
      </div>
      <button type="button" className="lb-close" onClick={onClose} aria-label="閉じる"><Icon name="x" size={22} /></button>
      <a className="lb-dl" href={src} download aria-label="ダウンロード"><Icon name="download" size={20} /></a>
    </div>
  );
}

function DocItem({ l, close }: { l: any; close: () => void }) {
  // 写真かどうかは、読み込めたかで決める（PDF などは読み込めないので、開くボタンだけになる）
  const [shown, setShown] = useState(safePath(l.download) && l.image !== false);
  const enlarge = () => { openOverlay((done) => <Lightbox src={l.download} onClose={() => done()} />); };
  return (
    <div className="chat-doc">
      {shown ? <button type="button" className="chat-doc-img" onClick={enlarge} aria-label="大きく見る"><img src={l.download} alt="書類の画像" loading="lazy" onError={() => setShown(false)} /></button> : null}
      <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
        {shown ? <button type="button" className="btn ui-link" onClick={enlarge}><Icon name="zoomIn" size={15} />大きく見る</button>
          : <Link className="btn ui-link" to={l.path} onClick={close}><Icon name="file" size={15} />{String(l.label || '書類を開く')}</Link>}
        {safePath(l.download) ? <a className="btn ui-link" href={l.download} download><Icon name="download" size={15} />ダウンロード</a> : null}
      </div>
    </div>
  );
}

function LinksCard({ block, close }: { block: any; close: () => void }) {
  const links = (Array.isArray(block.links) ? block.links : []).filter((l: any) => safePath(l.path));
  if (!links.length) return null;
  return <div className="ui-slot">{links.map((l: any, i: number) => <DocItem key={i} l={l} close={close} />)}</div>;
}

// 設定（市区町村・保険者ごとの値）の提案。入るのは、管理者が出典と見比べて押したときだけ
function SettingCard({ pr, onChange }: { pr: any; onChange: () => void }) {
  const state = pr.status;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const accept = async () => {
    setBusy(true);
    setErr('');
    try { await acceptSettingProposal(pr); toast('設定しました'); await note(`設定しました：${settingTitle(pr)} ${settingLine(pr)}`); onChange(); }
    catch (e: any) { setBusy(false); setErr((e && e.message) || 'うまくいかなかった'); }
  };
  const reject = async () => { try { await post(`/api/proposals/${encodeURIComponent(pr.id)}/reject`, {}); await note(`やめました：${settingTitle(pr)}`); onChange(); } catch (e) { errorToast(e); } };
  return (
    <div className={`ui-card ${state}`}>
      <div className="uc-head"><span className="uc-ico"><Icon name="building" size={16} /></span>
        <div className="uc-title"><small>{state === 'pending' ? 'この値を設定します' : state === 'accepted' ? '設定しました' : 'やめました'}</small><b>{settingTitle(pr)}</b></div>
        {state === 'accepted' ? <span className="chip ok"><Icon name="check" size={12} />設定済み</span> : state === 'rejected' ? <span className="chip">やめた</span> : <span className="chip unverified">AI</span>}</div>
      <SettingBody pr={pr} />
      {err ? <div className="uc-err"><Icon name="alert" size={14} /><div><b>このままでは設定できません</b><div>{err}</div></div></div> : null}
      {state === 'pending' ? (
        <div className="uc-foot">
          <button type="button" className="btn ghost" onClick={reject}>やめる</button>
          <button type="button" className="btn primary" disabled={busy} onClick={accept}><Icon name="check" size={15} />設定する</button>
        </div>
      ) : null}
    </div>
  );
}

// 登録の確認（1件）。登録は人が押したときだけ
function ProposalCard({ pr, onChange }: { pr: any; onChange: () => void }) {
  const rec = (pr.payload || {}).record || {};
  const state = pr.status;
  const ev = pr.evidence_id;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ items: string[]; message: string } | null>(null);
  const accept = async () => {
    if (pr.kind !== 'delete' && assumedOf(pr).length) { edit(); return; } // 補った欄は、確かめてからでないと登録しない
    setBusy(true);
    setErr(null);
    try { if (isPersonProposal(pr)) await acceptPersonProposal(pr); else await postChecked(`/api/proposals/${encodeURIComponent(pr.id)}/accept`, {}); toast(DONE[pr.kind] || '登録しました'); await note(`${DONE[pr.kind] || '登録しました'}：${titleOf(pr)} ${summaryLine(pr)}`); refreshStatus(); onChange(); }
    catch (e: any) {
      setBusy(false);
      const items: string[] = e instanceof ApiError && Array.isArray(e.detail) ? e.detail.slice(0, 5).map((d: any) => humanize(d.message || '')) : [];
      setErr({ items, message: (e && e.message) || '' });
    }
  };
  const reject = async () => { try { await post(`/api/proposals/${encodeURIComponent(pr.id)}/reject`, {}); await note(`やめました：${titleOf(pr)}`); onChange(); } catch (e) { errorToast(e); } };
  const edit = async () => { try { if (await editAndAccept(pr)) { toast('登録しました'); await note(`直して登録しました：${titleOf(pr)}`); refreshStatus(); onChange(); } } catch (e) { errorToast(e); } };
  return (
    <div className={`ui-card ${state}`}>
      <div className="uc-head"><span className="uc-ico"><Icon name={isPersonProposal(pr) ? 'users' : pr.kind === 'record' ? 'file' : 'flag'} size={16} /></span>
        <div className="uc-title"><small>{state === 'pending' ? (pr.kind === 'delete' ? 'この記録を取り消します' : pr.kind === 'correct' ? 'この内容に直します' : 'この内容で登録します') : state === 'accepted' ? (DONE[pr.kind] || '登録しました') : 'やめました'}</small><b>{titleOf(pr)}</b></div>
        {state === 'accepted' ? <span className="chip ok"><Icon name="check" size={12} />{pr.kind === 'delete' ? '取消し済み' : pr.kind === 'correct' ? '訂正済み' : '登録済み'}</span> : state === 'rejected' ? <span className="chip">やめた</span> : <span className="chip unverified">AI</span>}</div>
      {ev ? <a className="uc-ev" href={`/api/evidence/${encodeURIComponent(ev)}/file`} target="_blank" rel="noopener"><Icon name="file" size={14} />書類</a> : null}
      <div className="uc-body">{isPersonProposal(pr) ? (
        <>
          <div className="cr-row"><span className="cr-k">名前</span><span className="cr-v">{rec.display_name}</span></div>
          <div className="cr-row"><span className="cr-k">生年月日</span><span className="cr-v">{rec.birth_on}</span></div>
        </>
      ) : recordRows(rec, pr.payload || {})}</div>
      {pr.rationale ? <div className="uc-why">{humanize(pr.rationale)}</div> : null}
      <div>{err ? (
        <div className="uc-err"><Icon name="alert" size={14} /><div><b>このままでは登録できません</b>
          {err.items.length ? <ul>{err.items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <div>{err.message}</div>}
          <div className="muted">「直す」で中身を直して登録できます</div></div></div>
      ) : null}</div>
      {state === 'pending' ? (
        <div className="uc-foot">
          <button type="button" className="btn ghost" onClick={reject}>やめる</button>
          {pr.kind === 'delete' ? null : <button type="button" className="btn" onClick={edit}>直す</button>}
          <button type="button" className={`btn ${pr.kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy} onClick={accept}><Icon name="check" size={15} />{pr.kind === 'delete' ? '取り消す' : assumedOf(pr).length ? '確かめて登録' : pr.kind === 'correct' ? '訂正する' : '登録'}</button>
        </div>
      ) : null}
    </div>
  );
}

// まとめて登録の行を押したとき：モーダルの中で1件を見て直す（押したあとの状態を取り直して出す）
function ProposalInModal({ first, onChange }: { first: any; onChange: () => Promise<void> }) {
  const [pr, setPr] = useState<any>(first);
  const changed = async () => {
    get(`/api/proposals/${encodeURIComponent(first.id)}`).then(setPr).catch(() => {});
    await onChange();
  };
  return <div>{isSettingProposal(pr) ? <SettingCard pr={pr} onChange={changed} /> : <ProposalCard pr={pr} onChange={changed} />}</div>;
}

function ProposalsCard({ ids }: { ids: string[] }) {
  const [prs, setPrs] = useState<any[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const load = async () => {
    const got = (await Promise.all(idsRef.current.map((id) => get(`/api/proposals/${encodeURIComponent(id)}`).catch(() => null)))).filter(Boolean);
    setPrs(got);
    setSel(new Set(got.filter((p: any) => p.status === 'pending').map((p: any) => p.id)));
  };
  const idKey = ids.join(',');
  useEffect(() => { load(); }, [idKey]);

  if (prs === null) return <div className="ui-slot"><div className="ui-card loading"><span className="spinner" /> 読み込み中</div></div>;
  if (!prs.length) return <div className="ui-slot" />;
  if (prs.length === 1) return <div className="ui-slot">{isSettingProposal(prs[0]) ? <SettingCard pr={prs[0]} onChange={load} /> : <ProposalCard pr={prs[0]} onChange={load} />}</div>;
  const pending = prs.filter((p) => p.status === 'pending');
  const openRow = async (p: any) => {
    await modal(titleOf(p), <ProposalInModal first={p} onChange={load} />, [{ label: '閉じる', value: true }]);
    load();
  };
  const acceptAll = async () => {
    setBusy(true);
    let n = 0;
    let held = 0;
    for (const id of [...sel]) {
      // AI が補った欄のある記録は、まとめては登録しない（行を開いて確かめる）
      const one = (prs || []).find((x) => x.id === id);
      // 設定（出典と見比べるもの）も、まとめては入れない
      if (assumedOf(one).length || isSettingProposal(one)) { held += 1; continue; }
      try { await postChecked(`/api/proposals/${encodeURIComponent(id)}/accept`, {}); n += 1; } catch (err) { errorToast(err); }
    }
    toast(held ? `${n}件を登録しました。${held}件は、行を開いて確かめてください` : `${n}件を登録しました`);
    await note(`${n}件を登録しました`);
    refreshStatus();
    await load();
    setBusy(false);
  };
  return (
    <div className="ui-slot">
      <div className="ui-card">
        <div className="uc-head"><span className="uc-ico"><Icon name="layers" size={16} /></span>
          <div className="uc-title"><small>{pending.length ? 'この内容で登録します' : '登録しました'}</small><b>{`${prs.length}件の記録`}</b></div></div>
        <div className="uc-list">{prs.map((p) => (
          <div className={`uc-item ${p.status}`} key={p.id}>
            <input type="checkbox" checked={sel.has(p.id)} disabled={p.status !== 'pending'} aria-label="選ぶ"
              onChange={(e) => { const next = new Set(sel); if (e.target.checked) next.add(p.id); else next.delete(p.id); setSel(next); }} />
            <button type="button" className="uc-item-main" onClick={() => openRow(p)}><b>{titleOf(p)}</b><small className="muted">{summaryLine(p)}</small></button>
            {p.status === 'accepted' ? <Icon name="check" size={15} cls="ok-text" /> : p.status === 'rejected' ? <small className="muted">やめた</small> : <Icon name="chevronRight" size={15} cls="muted" />}
          </div>
        ))}</div>
        {pending.length ? (
          <div className="uc-foot"><small className="muted grow">行を押すと中身を見て直せます</small>
            <button type="button" className="btn primary" disabled={busy} onClick={acceptAll}><Icon name="check" size={15} /><span>{`${sel.size}件を登録`}</span></button></div>
        ) : null}
      </div>
    </div>
  );
}

// 質問：押すと答えが次のメッセージになる（選んだ答えはこの端末に覚えておく）
function ChoicesCard({ block, storeKey, send }: { block: any; storeKey: string; send: (o: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(storeKey));
  return (
    <div className="ui-card choice-card">
      <div className="uc-head"><span className="uc-ico"><Icon name="question" size={16} /></span><div className="uc-title"><b>{block.question}</b></div></div>
      <div className="uc-choices">{block.options.map((o: string, i: number) => (
        <button type="button" key={i} className={`btn ${chosen === o ? 'primary' : ''}`} disabled={!!chosen} onClick={() => { localStorage.setItem(storeKey, o); setChosen(o); send(o); }}>{o}</button>
      ))}</div>
    </div>
  );
}

function BookCard({ block, close }: { block: any; close: () => void }) {
  return (
    <div className="ui-card">
      <div className="uc-head"><span className="uc-ico"><Icon name="list" size={16} /></span>
        <div className="uc-title"><small>家計簿の登録待ちに入れました</small><b>{`${block.count}件の入出金`}</b></div></div>
      {block.duplicates ? <div className="uc-why">{`${block.duplicates}件は前に入れたものと同じなので外しました`}</div> : null}
      <div className="uc-foot"><Link className="btn primary" to="/txns/pending" onClick={() => close()}>登録待ちを開く<Icon name="chevronRight" size={15} /></Link></div>
    </div>
  );
}

// 裏で進む返事を待つ（途中経過：「計算結果を見ています…」）
async function waitRun(rid: string, setLabel: (label: string) => void): Promise<any> {
  setLabel('');
  for (let i = 0; i < 900; i += 1) {
    await new Promise((res) => { setTimeout(res, i < 5 ? 700 : 1500); });
    const r = await get(`/api/agent/runs/${encodeURIComponent(rid)}`);
    const last: string | undefined = r.progress[r.progress.length - 1];
    setLabel(last ? `${TOOL_LABEL[last] || (last.startsWith('propose') ? '登録する内容' : last === 'ask_user' ? '質問' : '情報')}を${last.startsWith('propose') || last === 'ask_user' ? '作っています' : '見ています'}…` : '');
    if (r.status === 'done') return r;
    if (r.status === 'error') throw new Error(r.error || 'AI の返事を作れなかった');
  }
  throw new Error('時間がかかりすぎています');
}

// 道具の呼び出しは1行にまとめる（押すと順番を出す）
function ToolsLine({ seen, tools }: { seen: string[]; tools: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="msg-tools" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><Icon name="search" size={13} />{`${seen.join('・')}を見ました`}</summary>
      <div className="muted">{tools.map((n) => TOOL_LABEL[n] || '提案').join(' → ')}</div>
    </details>
  );
}

// ------------------------------------------------------------------ 会話の画面
type Att = { key: number; name: string; state: 'up' | 'ok'; thumb: string | null; id: string | null };
let attSeq = 0;

const fmtTime = (t: any) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function ChatShell({ scope, prefill, close }: { scope: any; prefill?: string; close: () => void }) {
  const c = useChat();
  const [text, setTextState] = useState(typeof prefill === 'string' ? prefill : '');
  const textRef = useRef(text);
  const setText = (v: string) => { textRef.current = v; setTextState(v); };
  const [atts, setAttsState] = useState<Att[]>([]);
  const attsRef = useRef<Att[]>([]);
  const updAtts = (fn: (l: Att[]) => Att[]) => { attsRef.current = fn(attsRef.current); setAttsState(attsRef.current); };
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => { busyRef.current = v; setBusyState(v); };
  const [typing, setTyping] = useState<{ label: string | null } | null>(null);
  const [drop, setDrop] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const scrollEnd = () => setScrollTick((n) => n + 1);
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [scrollTick]);
  // 入力欄の高さを中身に合わせる（160px まで）
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [close]);

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      if (attsRef.current.length >= 5) { toast('添付は5個まで', 'bad'); break; }
      const a: Att = { key: ++attSeq, name: f.name || (f.type.startsWith('image/') ? '画像.png' : 'ファイル'), state: 'up', thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null, id: null };
      updAtts((l) => [...l, a]);
      try {
        const r = await api('POST', `/api/evidence?name=${encodeURIComponent(a.name)}&label=${encodeURIComponent(a.name.slice(0, 100))}`, undefined, { raw: f, contentType: f.type || 'application/octet-stream' });
        updAtts((l) => l.map((x) => (x.key === a.key ? { ...x, id: r.id, state: 'ok' } : x)));
      } catch (e) { errorToast(e); updAtts((l) => l.filter((x) => x.key !== a.key)); }
    }
  };

  async function doSend(textArg?: string, ack = false): Promise<void> {
    const msg = (textArg ?? textRef.current).trim();
    const ready = attsRef.current.filter((a) => a.state === 'ok');
    if (busyRef.current || (!msg && !ready.length)) return;
    if (attsRef.current.some((a) => a.state === 'up')) { toast('アップロード中です', 'bad'); return; }
    setBusy(true);
    const shown = { role: 'user', content: msg || '添付を読んで、登録する内容を提案して', attachments: ready.map((a) => ({ name: a.name })) };
    // 途中で別の会話に切り替えられたら、この返事はいまの会話に混ぜない（返事は履歴に残っている）
    const mine = () => chat.msgs.includes(shown);
    const dropShown = () => { if (mine()) setChat({ id: chat.id, msgs: chat.msgs.filter((m) => m !== shown) }); };
    setChat({ id: chat.id, msgs: [...chat.msgs, shown] });
    setTyping({ label: null });
    scrollEnd();
    if (textArg === undefined) setText('');
    try {
      const started = await post('/api/agent/chat', { chat_id: chat.id, message: msg, attachments: ready.map((a) => a.id), acknowledge_external: ack || undefined });
      if (mine()) { setChat({ id: started.chat_id, msgs: chat.msgs }); localStorage.setItem('okura.chat', started.chat_id); }
      const r = await waitRun(started.run_id, (label) => setTyping({ label }));
      if (mine()) {
        localStorage.setItem('okura.chat', started.chat_id);
        setChat({ id: started.chat_id, msgs: [...chat.msgs.filter((m) => m !== shown), ...r.messages] });
      }
      updAtts(() => []);
      if (r.trace.some((t: any) => t.proposal_id)) refreshStatus();
    } catch (e) {
      if (textArg === undefined && !textRef.current) setText(msg);
      if (e instanceof ApiError && e.code === 'ack_required') {
        setBusy(false);
        const ok = await modal('外部の AI に送りますか？', (
          <div className="stack">
            <p style={{ margin: 0 }}>{`送り先：${scope.model}`}</p>
            <p style={{ margin: 0 }}>名前・住所などは伏せて送ります。添付の写真・表は伏せられません</p>
            <p className="muted" style={{ margin: 0 }}>対象：{scope.persons_sent.map((p: any) => p.name).join('、') || 'なし'}</p>
            {scope.persons_not_sent.length ? <p className="muted" style={{ margin: 0 }}>送らない：{scope.persons_not_sent.map((p: any) => p.name).join('、')}</p> : null}
          </div>
        ), [{ label: 'やめる', value: false }, { label: '送る', value: true, kind: 'primary' }]);
        dropShown();
        if (ok) { setText(''); return doSend(msg, true); }
        setTyping(null);
        return;
      }
      dropShown();
      errorToast(e);
    }
    setBusy(false);
    setTyping(null);
    scrollEnd();
  }

  const newChat = () => { setChat({ id: null, msgs: [] }); localStorage.removeItem('okura.chat'); setHistory(null); input.current?.focus(); };

  // 履歴：前の会話の一覧（最初の質問・最後の日時）。押すとその会話の続きから
  const openHistory = async () => {
    try { setHistory((await get('/api/agent/chats')).chats); } catch (e) { errorToast(e); }
  };
  const pickHistory = async (id: string) => {
    try {
      const d = await get(`/api/agent/chats/${encodeURIComponent(id)}`);
      setChat({ id, msgs: d.messages });
      localStorage.setItem('okura.chat', id);
      setHistory(null);
      scrollEnd();
    } catch (e) { errorToast(e); }
  };

  const turns: Array<{ user: any; parts: any[] }> = [];
  for (const m of c.msgs) {
    if (m.role === 'user') turns.push({ user: m, parts: [] });
    else if (turns.length) turns[turns.length - 1].parts.push(m);
  }
  const off = !text.trim() && !atts.some((a) => a.state === 'ok');

  return (
    <div className={`chat-shell${drop ? ' drop' : ''}`} role="dialog" aria-label="AI"
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); addFiles([...(e.dataTransfer ? e.dataTransfer.files : [])]); }}>
      <div className="chat-head">
        <span className="ch-ico"><Icon name="sparkles" size={16} /></span><b>AI</b>
        <span className={`chip ${scope.external ? 'warn' : 'ok'}`} title={scope.external ? '名前などは伏せて送ります' : ''}>{scope.external ? '外部' : 'このPC'}</span>
        <div className="grow" />
        <button type="button" className="btn ghost small icon" title="履歴" aria-label="履歴" onClick={openHistory}><Icon name="history" size={17} /></button>
        <button type="button" className="btn ghost small icon" title="新しい会話" aria-label="新しい会話" onClick={newChat}><Icon name="plus" size={17} /></button>
        <button type="button" className="btn ghost small icon" title="閉じる" aria-label="閉じる" onClick={close}><Icon name="x" size={17} /></button>
      </div>
      <div className="chat-list" ref={list}>
        {!turns.length ? (
          <div className="chat-empty"><div className="ce-ico"><Icon name="sparkles" size={26} /></div><b>何をしますか？</b>
            <div className="ce-sugs">{SUGGEST.map((s) => <button type="button" className="pchip" key={s} onClick={() => { setText(s); input.current?.focus(); }}>{s}</button>)}</div></div>
        ) : turns.map((t, ti) => {
          const tools: string[] = t.parts.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((x: any) => x.function.name));
          const seen = [...new Set(tools.map((n) => TOOL_LABEL[n]).filter(Boolean))];
          const texts = t.parts.filter((m) => m.role === 'assistant' && m.content && m.content.trim());
          const ui: any[] = t.parts.filter((m) => m.ui).flatMap((m) => m.ui);
          return (
            <Fragment key={ti}>
              {t.user.note ? <div className="chat-note">{t.user.content.replace(/^（画面で：|）$/g, '')}</div> : (
                <div className="msg-user">
                  {(t.user.attachments || []).length ? <div className="mu-att">{t.user.attachments.map((a: any, i: number) => <span className="att ok" key={i}><Icon name="file" size={12} /><span className="att-name">{a.name}</span></span>)}</div> : null}
                  <div className="bubble">{t.user.content}</div>
                </div>
              )}
              {seen.length ? <ToolsLine seen={seen} tools={tools} /> : null}
              {texts.map((m, i) => <div className="msg-ai" key={`t${i}`}><Md src={humanize(m.content)} /></div>)}
              {ui.map((b, bi) => (b.type === 'proposals' ? <ProposalsCard key={`u${bi}`} ids={b.ids} />
                : b.type === 'choices' ? <ChoicesCard key={`okura.choice.${c.id}.${ti}.${bi}`} block={b} storeKey={`okura.choice.${c.id}.${ti}.${bi}`} send={(o) => { doSend(o); }} />
                  : b.type === 'book' ? <BookCard key={`u${bi}`} block={b} close={close} />
                    : b.type === 'link' ? <LinkCard key={`u${bi}`} block={b} close={close} />
                      : b.type === 'links' ? <LinksCard key={`u${bi}`} block={b} close={close} /> : null))}
            </Fragment>
          );
        })}
        {typing ? <div className="msg-ai typing"><span /><span /><span />{typing.label !== null ? <span className="typing-label">{typing.label}</span> : null}</div> : null}
      </div>
      <div className="chat-bar">
        <div className="chat-box">
          <div className="att-row">
            {atts.map((a) => (
              <span className={`att ${a.state}`} key={a.key}>
                {a.thumb ? <img src={a.thumb} alt="" /> : <Icon name={a.name.endsWith('.pdf') ? 'file' : /\.(xlsx|csv|tsv)$/i.test(a.name) ? 'list' : 'file'} size={14} />}
                <span className="att-name">{a.name}</span>{a.state === 'up' ? <span className="spinner" /> : null}
                <button type="button" className="att-x" aria-label="外す" onClick={() => updAtts((l) => l.filter((x) => x.key !== a.key))}><Icon name="x" size={12} /></button>
              </span>
            ))}
            {scope.external && atts.length ? <div className="att-warn"><Icon name="lock" size={12} />添付は伏せ字にできません。外部の AI に送ります</div> : null}
          </div>
          <textarea className="chat-in" rows={1} placeholder="メッセージ" aria-label="メッセージ" ref={input} value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const fs = [...(e.clipboardData ? e.clipboardData.files : [])];
              if (fs.length) { e.preventDefault(); addFiles(fs); }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } }} />
          <div className="chat-tools">
            <button type="button" className="chat-attach" aria-label="ファイルを添付" title="写真・PDF・Excel・CSV" onClick={() => file.current?.click()}><Icon name="plus" size={20} /></button>
            <button type="button" className={`chat-send${off ? ' off' : ''}`} aria-label="送る" disabled={busy} onClick={() => { doSend(); }}><Icon name="arrowUp" size={18} /></button>
          </div>
          <input type="file" accept={ACCEPT} multiple hidden ref={file} onChange={(e) => { addFiles([...(e.target.files || [])]); e.target.value = ''; }} />
        </div>
      </div>
      {history ? (
        <div className="chat-history">
          <div className="chh-head"><b>履歴</b><div className="grow" />
            <button type="button" className="btn small" onClick={newChat}><Icon name="plus" size={14} />新しい会話</button>
            <button type="button" className="btn ghost small icon" aria-label="閉じる" onClick={() => setHistory(null)}><Icon name="x" size={16} /></button></div>
          {history.length ? (
            <div className="chh-list">{history.map((h) => (
              <button type="button" key={h.id} className={`chh-item ${h.id === c.id ? 'on' : ''}`} onClick={() => pickHistory(h.id)}>
                <span className="chh-title">{h.title}</span><small className="muted">{fmtTime(h.updated_at || h.created_at)}</small>
              </button>
            ))}</div>
          ) : <div className="chat-empty"><b>まだ会話がありません</b></div>}
        </div>
      ) : null}
    </div>
  );
}

// 開いている会話の画面（二重に開かない。開き直すときは前のものを閉じる）
let current: { close: () => void } | null = null;
let openSeq = 0;

export async function openAgent(prefill?: string): Promise<void> {
  const my = ++openSeq;
  if (current) { current.close(); current = null; }
  let scope: any;
  try { scope = await get('/api/agent/scope'); } catch (e) { errorToast(e); return; }
  PSEUDO = scope.pseudonyms || {};
  await loadMeta();
  if (chat.id && !chat.msgs.length) {
    try { const d = await get(`/api/agent/chats/${encodeURIComponent(chat.id)}`); if (!chat.msgs.length) setChat({ id: chat.id, msgs: d.messages }); } catch { setChat({ id: null, msgs: [] }); }
  }
  if (my !== openSeq) return; // 待っているあいだにもう一度呼ばれた（あとのほうが開く）
  const pr = openOverlay((close) => <ChatShell scope={scope} prefill={prefill} close={() => close()} />, { persist: true });
  const handle = { close: () => pr.close() };
  current = handle;
  pr.then(() => { if (current === handle) current = null; });
}

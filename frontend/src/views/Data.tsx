// 記録（台帳）と家族
import { postChecked } from '../lib/writes';
import { Fragment, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type JSX, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { get, post, ApiError } from '../lib/api';
import { yen, ageOn, today } from '../lib/format';
import { QUICK, FAMILY_QUICK, RecordForm, fieldsForRecord, fieldsForLedger, recordSummary, recordDate, type FormHandle } from '../lib/forms';
import { fieldLabel, enumLabel, prettyValue } from '../lib/labels.js';
import { refreshStatus } from '../lib/status';
import { S, setS, useS, loadMeta, loadRecords, loadHousehold, personName, kindMeta, kindTitle, formCtx } from '../lib/store';
import { useApi } from '../lib/useApi';
import { Icon } from '../ui/Icon';
import { Avatar, ErrorNote, ProblemsList, Skeleton } from '../ui/bits';
import { toast, errorToast, openDrawer, modal, askText } from '../ui/overlay';

const SECTION_LABEL: Record<string, string> = { relations: '続柄', residences: '住所', insurance_memberships: '保険・年金', facts: '収入・支出', assets: '資産・契約', filed_documents: '提出書類', judgments: '回答', choices: '回答' };

function valueText(_k: string, v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? (S.persons.some((p) => p.person_id === x) ? personName(x) : enumLabel(x)) : prettyValue(x))).join('・');
  if (typeof v === 'object') return prettyValue(v);
  if (typeof v === 'string' && S.persons.some((p) => p.person_id === v)) return personName(v);
  return enumLabel(String(v));
}

function KvBlock({ title, obj, money = false }: { title: string; obj: any; money?: boolean }) {
  if (!obj || !Object.keys(obj).length) return null;
  return (
    <>
      <h3>{title}</h3>
      <dl className="kv">
        {Object.entries(obj).map(([k, v]) => (
          <Fragment key={k}>
            <dt>{fieldLabel(k)}</dt>
            <dd className={money ? 'num' : undefined} style={money ? { textAlign: 'left' } : undefined}>{money && typeof v === 'number' ? yen(v) : valueText(k, v)}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}

// 書類の小さい絵（絵として出せないもの＝PDF などは文字にする）
function Thumb({ eid }: { eid: string }) {
  const [bad, setBad] = useState(false);
  return (
    <Link className="thumb" to={`/evidence/${eid}`}>
      <div className="img">{bad ? 'PDF など' : <img src={`/api/evidence/${eid}/file`} alt="書類" onError={() => setBad(true)} />}</div>
    </Link>
  );
}

const OP_LABEL: Record<string, string> = { add: '作成', correct: '修正', delete: '削除' };

function RecordDetail({ r, close, after }: { r: any; close: () => void; after?: () => void }) {
  const rec = r.record;
  const isLedger = ['judgments', 'choices'].includes(r.section);
  const remove = async () => {
    const reason = await askText('削除', '理由');
    if (!reason) return;
    try {
      await post(`/api/records/${encodeURIComponent(rec.id)}/delete`, { reason });
      toast('削除しました');
      close();
      await refreshStatus();
      after && after();
    } catch (e) { errorToast(e); }
  };
  return (
    <div className="stack">
      <div className="row"><span className="chip">{SECTION_LABEL[r.section] || r.section}</span><b>{kindTitle(rec.kind)}</b>{rec.mark ? <span className="chip forecast">{rec.mark}</span> : null}</div>
      <KvBlock title="人" obj={rec.roles || rec.subject} />
      <KvBlock title="日付" obj={rec.when} />
      <KvBlock title="金額" obj={rec.amounts} money />
      <KvBlock title="内容" obj={rec.attributes} />
      {isLedger ? <KvBlock title="回答" obj={{ 回答: rec.value, 回答した人: rec.judged_by ? personName(rec.judged_by.person) || rec.judged_by.label : personName(rec.chosen_by), 日時: (rec.judged_at || rec.chosen_at || '').replace('T', ' '), 変更前: rec.replaces }} /> : null}
      {rec.basis ? <KvBlock title="根拠" obj={rec.basis} /> : null}
      {rec.note ? <p>メモ：{rec.note}</p> : null}
      {r.evidence && r.evidence.length ? (
        <>
          <h3>書類</h3>
          <div className="thumbs">{r.evidence.map((eid: string) => <Thumb key={eid} eid={eid} />)}</div>
        </>
      ) : (rec.source && rec.source.evidence_sha256 ? <p className="muted">書類は非公開</p> : null)}
      {r.history && r.history.length ? (
        <>
          <h3>変更履歴</h3>
          <div className="table-wrap"><table className="t">
            <thead><tr><th></th><th>日時</th><th>変更した人</th><th>理由</th></tr></thead>
            <tbody>{r.history.map((x: any, i: number) => (
              <tr key={i}><td>{OP_LABEL[x.op] || x.op}</td><td>{(x.recorded_at || '').replace('T', ' ')}</td><td>{personName((x.recorded_by || {}).person) || (x.recorded_by || {}).label || ''}</td><td>{x.reason || ''}</td></tr>
            ))}</tbody>
          </table></div>
        </>
      ) : null}
      <div className="row" style={{ marginTop: '12px' }}>
        {isLedger ? <button type="button" className="btn" onClick={() => { close(); openLedgerForm(kindMeta(rec.kind), { ...rec, replaces: rec.id, id: undefined }, after, '回答を変更'); }}>回答を変更</button>
          : r.section !== 'persons' ? (
            <>
              <button type="button" className="btn" onClick={() => { close(); openRecordForm(kindMeta(rec.kind), rec, after, { correct: true }); }}>修正</button>
              <button type="button" className="btn danger" onClick={remove}>削除</button>
            </>
          ) : null}
      </div>
    </div>
  );
}

export function openRecord(rid: string, after?: () => void): void {
  (async () => {
    let r: any;
    try { [r] = await Promise.all([get(`/api/records/${encodeURIComponent(rid)}`), loadMeta()]); } catch (e) { errorToast(e); return; }
    openDrawer(kindTitle(r.record.kind), (close) => <RecordDetail r={r} close={() => close()} after={after} />);
  })();
}

/** 保存できなかったときの知らせ（フォームの下） */
function SaveError({ err }: { err: any }) {
  return <div>{err ? <div className="note bad">{err.message}<ProblemsList detail={err.detail} /></div> : null}</div>;
}

function RecordFormBody({ km, initial, after, opts, close }: { km: any; initial: any; after?: (saved?: any) => void; opts: any; close: () => void }) {
  const form = useRef<FormHandle>(null);
  const [err, setErr] = useState<any>(null);
  const [ctx] = useState(formCtx); // 開いたときの人・記録で作る
  const fields = useMemo(() => fieldsForRecord(km), [km]);
  const q = [...QUICK, ...FAMILY_QUICK].find((x) => x.kind === km.kind);
  const save = async () => {
    const { value, errors } = form.current!.read();
    if (errors.length) { toast('入力エラーがあります', 'bad'); return; }
    value.kind = km.kind;
    let saved: any = null;
    try {
      if (opts.correct) {
        const reason = await askText('修正の理由', '理由');
        if (!reason) return;
        await post(`/api/records/${encodeURIComponent(initial.id)}/correct`, { record: value, reason });
      } else {
        saved = await postChecked('/api/records', { section: km.section, record: value, evidence_ids: opts.evidence ? [opts.evidence] : [] });
      }
      toast('保存しました');
      close();
      await loadRecords(true);
      await refreshStatus();
      after && after(saved);
    } catch (e) { errorToast(e); if (e instanceof ApiError) setErr(e); }
  };
  return (
    <div className="stack">
      <RecordForm ref={form} fields={fields} initial={initial || {}} main={q ? q.main : null} ctx={ctx} sync={q ? q.sync : null} />
      <SaveError err={err} />
      <div className="row"><button type="button" className="btn primary big" onClick={save}>保存</button></div>
    </div>
  );
}

export async function openRecordForm(km: any, initial?: any, after?: (saved?: any) => void, opts: any = {}): Promise<void> {
  await Promise.all([loadMeta(), loadRecords()]);
  openDrawer(`${km.title}${opts.correct ? 'の修正' : ''}`, (close) => <RecordFormBody km={km} initial={initial} after={after} opts={opts} close={() => close()} />, { wide: true });
}

function LedgerFormBody({ lk, initial, after, close }: { lk: any; initial: any; after?: (saved?: any) => void; close: () => void }) {
  const form = useRef<FormHandle>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<any>(null);
  const [ctx] = useState(formCtx);
  const fields = useMemo(() => fieldsForLedger(lk), [lk]);
  const main = useMemo(() => fields.map((f) => f.path), [fields]);
  const save = async () => {
    const { value, errors } = form.current!.read();
    if (errors.length) { toast('入力エラーがあります', 'bad'); return; }
    value.kind = lk.kind;
    if (lk.mark) value.mark = lk.mark;
    if (initial && initial.replaces) value.replaces = initial.replaces;
    try {
      await post('/api/judgments', { section: lk.section, record: value, basis_note: note || undefined });
      toast('保存しました');
      close();
      await loadRecords(true);
      await refreshStatus();
      after && after();
    } catch (e) { errorToast(e); if (e instanceof ApiError) setErr(e); }
  };
  return (
    <div className="stack">
      <div className="note undet">{`これは人が決めること（${lk.section === 'choices' ? '選択' : '判断'}）。あなた（${S.me.user.display_name}）が今決めたこととして、だれが・いつ決めたかを記録する。`}</div>
      {lk.mark ? <div className="note warn">{`印「${lk.mark}」が付く。${lk.mark === '予測' ? '予測からは申告用の値は出ない。' : ''}`}</div> : null}
      <RecordForm ref={form} fields={fields} main={main} initial={initial || {}} ctx={ctx} />
      <div className="field"><label>メモ</label><input type="text" className="in" placeholder="メモ（任意）" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <SaveError err={err} />
      <div className="row"><button type="button" className="btn primary big" onClick={save}>保存</button></div>
    </div>
  );
}

export async function openLedgerForm(lk: any, initial?: any, after?: (saved?: any) => void, title?: string): Promise<void> {
  await Promise.all([loadMeta(), loadRecords()]);
  openDrawer(title || lk.title, (close) => <LedgerFormBody lk={lk} initial={initial} after={after} close={() => close()} />, { wide: true });
}

export async function chooseKindAndAdd(after?: () => void): Promise<void> {
  await loadMeta();
  const meta = S.meta;
  openDrawer('記録を追加', (close) => {
    const pick = (kind: string) => {
      if (!kind) return;
      close();
      const km = kindMeta(kind);
      if (['judgments', 'choices'].includes(km.section)) openLedgerForm(km, {}, after); else openRecordForm(km, {}, after);
    };
    return (
      <div className="stack">
        <div className="kinds">
          {[...QUICK, ...FAMILY_QUICK].map((q) => (
            <button type="button" className="kind-btn" key={q.id} onClick={() => pick(q.kind)}><span className="k-ico"><Icon name={q.icon} size={16} /></span><span className="k-name">{q.name}</span></button>
          ))}
        </div>
        <div className="section-title">その他の種類</div>
        <select className="in" defaultValue="" onChange={(e) => pick(e.target.value)}>
          <option value="">（選ぶ）</option>
          {Object.entries(SECTION_LABEL).map(([sec, label]) => (
            <optgroup label={label} key={sec}>
              {[...meta.records, ...meta.ledger].filter((k: any) => k.section === sec).map((k: any) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
    );
  });
}

/** 語彙（記録の種類の名前）を読んでおく */
function useMeta() {
  const meta = useS((s) => s.meta);
  const [error, setError] = useState<any>(null);
  useEffect(() => { loadMeta().catch(setError); }, []);
  return { meta, error };
}

/** 記録の一覧を読む。共有の状態（ほかの画面・フォームの選択肢）にも同じものを置く */
function useRecords() {
  const q = useApi('/api/records');
  const data = q.data;
  useEffect(() => { if (data && S.records !== data.records) setS({ records: data.records }); }, [data]);
  return q;
}

// ------------------------------------------------------------------ 記録の一覧
export function RecordsPage(): JSX.Element {
  const { rid } = useParams();
  const { meta, error: metaError } = useMeta();
  const q = useRecords();
  const persons = useS((s) => s.persons);
  const [y, setY] = useState('');
  const [p, setP] = useState('');
  const [s, setS1] = useState('');
  // 道に記録の ID があれば、その記録を開く（同じ記録を二重に開かない）
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!rid) { opened.current = null; return; }
    if (opened.current === rid) return;
    opened.current = rid;
    openRecord(rid);
  }, [rid]);

  if (!meta || !q.data) return (metaError || q.error) ? <ErrorNote error={metaError || q.error} /> : <Skeleton />;
  const recs: any[] = q.data.records;
  const hidden = q.data.hidden;
  const list = recs.filter((r) => (!p || r.persons.includes(p)) && (!s || r.section === s) && (!y || JSON.stringify(r.record.when || {}).includes(y)));
  return (
    <>
      <div className="page-head"><div className="grow"><h1>記録</h1>
        <p className="lead">収入・支出・家族の情報・質問への回答</p></div>
        <button type="button" className="btn primary" onClick={() => chooseKindAndAdd()}><Icon name="plus" size={15} />追加</button></div>
      {hidden ? <div className="note">{`非公開 ${hidden}件`}</div> : null}
      <div className="row" style={{ margin: '10px 0' }}>
        <select className="in" style={{ width: 'auto' }} value={y} onChange={(e) => setY(e.target.value)}>
          <option value="">すべての年</option>
          {[2027, 2026, 2025, 2024].map((yy) => <option key={yy} value={yy}>{`${yy}年`}</option>)}
        </select>
        <select className="in" style={{ width: 'auto' }} value={p} onChange={(e) => setP(e.target.value)}>
          <option value="">すべての人</option>
          {persons.map((x) => <option key={x.person_id} value={x.person_id}>{x.display_name}</option>)}
        </select>
        <select className="in" style={{ width: 'auto' }} value={s} onChange={(e) => setS1(e.target.value)}>
          <option value="">すべての種類</option>
          {Object.entries(SECTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>日付</th><th>種類</th><th>人</th><th>金額</th><th className="hide-sm">書類</th><th className="hide-sm">分類</th></tr></thead>
        <tbody>
          {list.length ? list.map((r) => (
            <tr className="click" key={r.record.id} onClick={() => openRecord(r.record.id)}>
              <td>{recordDate(r.record)}</td>
              <td>{kindTitle(r.record.kind)}{r.record.mark ? <span className="chip forecast" style={{ marginLeft: '4px' }}>{r.record.mark}</span> : null}</td>
              <td>{r.persons.map(personName).join('・')}</td>
              <td className="num">{recordSummary(r.record)}</td>
              <td className="hide-sm">{r.evidence.length ? <Icon name="receipt" size={15} /> : ''}</td>
              <td className="hide-sm"><span className="chip">{SECTION_LABEL[r.section]}</span></td>
            </tr>
          )) : <tr><td colSpan={6} className="empty">記録はありません</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

// ------------------------------------------------------------------ 家族
/** ダイアログの入力欄。値は hold[name] に置く（ダイアログを閉じたあとに読む） */
function HeldInput({ hold, name, ...rest }: { hold: Record<string, string>; name: string } & InputHTMLAttributes<HTMLInputElement>) {
  const [v, setV] = useState(hold[name] || '');
  return <input {...rest} value={v} onChange={(e) => { hold[name] = e.target.value; setV(e.target.value); }} />;
}

function HeldSelect({ hold, name, children }: { hold: Record<string, string>; name: string; children: ReactNode }) {
  const [v, setV] = useState(hold[name] || '');
  return <select className="in" value={v} onChange={(e) => { hold[name] = e.target.value; setV(e.target.value); }}>{children}</select>;
}

const CONSENT_LABEL: Record<string, string> = { share_numbers: '金額', share_details: '明細', share_originals: '書類', external_ai: 'AI' };
const OK_CANCEL = (ok: string) => [{ label: 'キャンセル', value: false }, { label: ok, value: true, kind: 'primary' }];

async function fixBirth(p: any, reload: () => void) {
  const v: Record<string, string> = { birth: p.birth_on || '', reason: '' };
  const ok = await modal('生年月日を修正', (
    <div className="form">
      <div className="field"><label>生年月日</label><HeldInput hold={v} name="birth" type="date" className="in" /></div>
      <div className="field"><label>理由</label><HeldInput hold={v} name="reason" type="text" className="in" placeholder="例：入力ミス" /></div>
    </div>
  ), OK_CANCEL('保存'));
  if (!ok) return;
  try { await post(`/api/persons/${p.person_id}/birth`, { birth_on: v.birth, reason: v.reason }); toast('保存しました'); await refreshStatus(); reload(); } catch (e) { errorToast(e); }
}

async function makeAccount(p: any, reload: () => void) {
  const v: Record<string, string> = { login: '', password: '', role: 'member' };
  const ok = await modal(`${p.display_name}さんを招待`, (
    <div className="form">
      <div className="field"><label>ログイン名</label><HeldInput hold={v} name="login" type="text" className="in" placeholder="英数字" /></div>
      <div className="field"><label>仮パスワード（10文字以上）</label><HeldInput hold={v} name="password" type="password" className="in" /></div>
      <div className="field"><label>権限</label><HeldSelect hold={v} name="role"><option value="member">メンバー</option><option value="admin">管理者</option></HeldSelect></div>
    </div>
  ), OK_CANCEL('招待'));
  if (!ok) return;
  try { await post('/api/members', { login: v.login, password: v.password, person_id: p.person_id, role: v.role }); toast('招待しました'); reload(); } catch (e) { errorToast(e); }
}

async function forecast(p: any, recs: any[]) {
  const y = new Date().getFullYear();
  const sal = recs.filter((r) => r.record.kind === 'salary_payment' && r.record.roles && r.record.roles.recipient === p.person_id && String((r.record.attributes || {}).due_on || (r.record.when || {}).on || '').startsWith(String(y)));
  const sum = sal.reduce((a, r) => a + ((r.record.amounts || {}).gross || 0), 0);
  const months = new Set(sal.map((r) => String((r.record.attributes || {}).due_on || r.record.when.on).slice(0, 7))).size;
  const now = new Date();
  const remaining = 12 - (now.getMonth() + 1);
  const avg = months ? Math.round(sum / months) : 0;
  const suggest = sum + avg * remaining;
  const v: Record<string, string> = { amt: suggest.toLocaleString('ja-JP'), on: today() };
  const ok = await modal(`${p.display_name}さんの年収の見込み`, (
    <div className="stack">
      <p>{`${y}年の給与：${months}か月分 ${yen(sum)}`}</p>
      <p className="muted">{`アプリの見込みの作り方（法令ではない）：これまでの月平均 ${yen(avg)} × 残りの ${remaining} か月 ＋ これまでの合計 = ${yen(suggest)}。直してよい。`}</p>
      <div className="field"><label>年収の見込み</label><HeldInput hold={v} name="amt" type="text" className="in yen-input" /></div>
      <div className="field"><label>基準日</label><HeldInput hold={v} name="on" type="date" className="in" /></div>
    </div>
  ), OK_CANCEL('保存'));
  if (!ok) return;
  const n = parseInt(v.amt.replace(/[,，円\s]/g, ''), 10);
  if (!Number.isInteger(n) || n < 0) { toast('金額を入力してください', 'bad'); return; }
  try {
    await post('/api/judgments', { section: 'judgments', record: { kind: '見込み.年間収入', subject: { person: p.person_id }, when: { on: v.on }, value: { amounts: [{ income_type: 'salary', amount: n }] }, mark: '予測' }, basis_note: `月平均×残りの月（アプリの見込み）：${sal.length}件の給与の記録から` });
    toast('保存しました');
    await refreshStatus();
  } catch (e) { errorToast(e); }
}

function FamilyCard({ p, isAdmin, recs, reload }: { p: any; isAdmin: boolean; recs: any[]; reload: () => void }) {
  const age = ageOn(p.birth_on, today());
  const rename = async () => {
    const v = await askText('名前を変更', '名前');
    if (!v) return;
    try { await post(`/api/persons/${p.person_id}/rename`, { display_name: v }); toast('変更しました'); reload(); } catch (e) { errorToast(e); }
  };
  return (
    <div className="card">
      <Link className="p-head row" to={`/person/${encodeURIComponent(p.person_id)}`}><Avatar id={p.person_id} name={p.display_name} />
        <div style={{ flex: 1 }}><b>{p.display_name}</b>{p.is_me ? <span className="chip ok" style={{ marginLeft: '6px' }}>あなた</span> : null}
          <div className="muted">{p.birth_on ? `${age}歳` : ''}・{p.has_account ? (p.role === 'admin' ? '管理者' : 'メンバー') : '招待していない'}</div></div></Link>
      <div className="row" style={{ gap: '4px', margin: '6px 0' }}>
        {Object.entries(CONSENT_LABEL).map(([k, l]) => (
          <span key={k} className={`chip ${p.consents[k] ? 'ok' : ''}`} title={p.consents_decided[k] ? '決めてある' : 'まだ決めていない'}><Icon name={p.consents[k] ? 'eye' : 'lock'} size={12} />{l}</span>
        ))}
      </div>
      <div className="row">
        {p.is_mine || isAdmin ? <button type="button" className="btn small" onClick={rename}>名前を変更</button> : null}
        {p.is_mine || isAdmin ? <button type="button" className="btn small" onClick={() => fixBirth(p, reload)}>生年月日を修正</button> : null}
        {p.can_decide ? <Link className="btn small" to="/settings/consents">共有設定</Link> : null}
        {!p.has_account && isAdmin ? <button type="button" className="btn small" onClick={() => makeAccount(p, reload)}>招待</button> : null}
        {p.sees_numbers ? <button type="button" className="btn small" onClick={() => forecast(p, recs)}>年収の見込み</button> : null}
      </div>
    </div>
  );
}

export function FamilyPage(): JSX.Element {
  const { meta, error: metaError } = useMeta();
  const q = useRecords();
  const persons = useS((s) => s.persons);
  const me = useS((s) => s.me);
  const [name, setName] = useState('');
  const [birth, setBirth] = useState('');
  // 世帯（人・共有設定）は開くたびに読む。名前・生年月日・招待を変えたあとも読み直す
  const reload = () => { loadHousehold().catch(errorToast); };
  useEffect(() => { loadHousehold().catch(errorToast); }, []);

  if (!meta || !q.data) return (metaError || q.error) ? <ErrorNote error={metaError || q.error} /> : <Skeleton />;
  const recs: any[] = q.data.records;
  const famKinds = new Set(FAMILY_QUICK.map((x) => x.kind));
  const famRecs = recs.filter((r) => famKinds.has(r.record.kind));
  const isAdmin = me.role === 'admin';
  const add = async () => {
    try {
      await post('/api/persons', { display_name: name, birth_on: birth });
      toast('追加しました');
      setName('');
      setBirth('');
      await loadHousehold();
    } catch (e) { errorToast(e); }
  };
  return (
    <>
      <div className="page-head"><div className="grow"><h1>家族</h1></div></div>
      <div className="grid c2">
        {persons.map((p) => <FamilyCard key={p.person_id} p={p} isAdmin={isAdmin} recs={recs} reload={reload} />)}
        <div className="card"><h3>家族を追加</h3>
          <div className="form">
            <div className="field"><label>名前</label><input type="text" className="in" placeholder="名前" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label>生年月日</label><input type="date" className="in" value={birth} onChange={(e) => setBirth(e.target.value)} /></div>
            <button type="button" className="btn primary" onClick={add}>追加</button>
          </div>
        </div>
      </div>
      <h2>家族の情報</h2>
      <div className="kinds">
        {FAMILY_QUICK.map((x) => (
          <button type="button" className="kind-btn" key={x.id} onClick={() => openRecordForm(kindMeta(x.kind), {}, reload)}><span className="k-ico"><Icon name={x.icon} size={16} /></span><span className="k-name">{x.name}</span></button>
        ))}
      </div>
      <div className="table-wrap" style={{ marginTop: '8px' }}><table className="t">
        <thead><tr><th>種類</th><th>人</th><th>日付</th><th className="hide-sm">内容</th></tr></thead>
        <tbody>
          {famRecs.length ? famRecs.map((r) => (
            <tr className="click" key={r.record.id} onClick={() => openRecord(r.record.id, reload)}>
              <td>{kindTitle(r.record.kind)}</td><td>{r.persons.map(personName).join('・')}</td><td>{recordDate(r.record)}</td>
              <td className="hide-sm">{Object.entries(r.record.attributes || {}).slice(0, 3).map(([k, v]) => `${fieldLabel(k)}：${valueText(k, v)}`).join('　')}</td>
            </tr>
          )) : <tr><td colSpan={4} className="empty">ありません</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

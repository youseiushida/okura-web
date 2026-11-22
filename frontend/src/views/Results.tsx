// 決めること（一問ずつの面接）・結果と根拠・申告書に写す
import { PersonDocs } from './Docs';
import { createRef, Fragment, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Link, useParams } from 'react-router';
import { get, post, ApiError } from '../lib/api';
import { timeLabel, timeKey, ageOn, today } from '../lib/format';
import { RecordForm, fieldsForLedger, type FormHandle } from '../lib/forms';
import { conceptLabel, enumLabel, MEANS, prettyValue } from '../lib/labels.js';
import { refreshStatus, recalc } from '../lib/status';
import { S, useS, useDigest, loadMeta, loadRecords, personName, kindMeta, kindTitle, formCtx } from '../lib/store';
import { useApi } from '../lib/useApi';
import { Icon } from '../ui/Icon';
import { Avatar, StateChips, ProblemsList, copyText, Skeleton } from '../ui/bits';
import { toast, errorToast, modal, openDrawer } from '../ui/overlay';
import { openAgent } from './Chat';
import { openRecordForm } from './Data';
import { WallView } from './Home';

// 語彙（記録の種類の名前）を読んでおく。読めるまでは null
function useMeta() {
  const meta = useS((s) => s.meta);
  useEffect(() => { if (!meta) loadMeta().catch(errorToast); }, [meta]);
  return meta;
}

function NoResult({ title }: { title: string }) {
  const latest = useS((s) => s.latest);
  const L = latest || {};
  const failed = L.last_job && L.last_job.status === 'failed' ? (L.last_job.error || {}) : null;
  return (
    <>
      <div className="page-head"><h1>{title}</h1></div>
      <div className="card empty"><Icon name={L.running ? 'refresh' : 'chart'} size={28} />
        <b>{L.running ? `計算中：${L.running.stage}` : 'まだ計算していません'}</b>
        {L.running ? null : <button type="button" className="btn primary" onClick={recalc} style={{ marginTop: '10px' }}><Icon name="refresh" size={14} />再計算</button>}
      </div>
      {failed ? <div className="note bad" style={{ marginTop: '12px' }}><Icon name="alert" size={16} /><div>{`計算エラー：${failed.message}`}<ProblemsList detail={failed.problems} /></div></div> : null}
    </>
  );
}

function StaleNote() {
  const latest = useS((s) => s.latest);
  if (latest && latest.result && latest.result.stale) {
    return <div className="note warn" style={{ marginBottom: '16px' }}><Icon name="refresh" size={16} /><div style={{ flex: 1 }}>記録が変わりました</div><button type="button" className="btn small" onClick={recalc}>再計算</button></div>;
  }
  return null;
}

// 開閉を state で持つ <details>
function Details({ summary, summaryStyle, style, children }: { summary: ReactNode; summaryStyle?: React.CSSProperties; style?: React.CSSProperties; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details style={style} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="muted" style={summaryStyle}>{summary}</summary>
      {children}
    </details>
  );
}

export function candLabel(c: any): string {
  const s = String(c);
  if (S.persons.some((p) => p.person_id === s)) return `${personName(s)}さんの扶養`;
  return enumLabel(s);
}

// 記録の種類の名前（resident_record など）を画面の言葉に直す。かっこの中の説明は落とす
function kindWords(s: any): string {
  return String(s || '').replace(/[a-z][a-z_]+/g, (k) => (kindMeta(k) ? kindMeta(k).title : '')).replace(/（[^）]*）/g, '').replace(/\s+/g, '');
}

function jpDate(s: any): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : String(s || '');
}

// 画面に出す条件の文。システムの中の名前（英字のキー・ID）は出さない
function targetText(t: any): string {
  const parts: string[] = [];
  const KL: Record<string, string> = { person: '人', other_person: '相手', on: '判定の日', tax_year: '年分', fiscal_year: '年度', 入力: '必要な記録', 賦課期日: '基準日', business_id: '事業' };
  for (const [k, v] of Object.entries<any>(t || {})) {
    if (!KL[k]) continue;
    let vs: string;
    if (typeof v === 'string' && S.persons.some((p) => p.person_id === v)) vs = personName(v);
    else if (k === '入力') vs = kindWords(v).split('か').filter(Boolean).join(' または ');
    else if (k === 'on' || k === '賦課期日') vs = jpDate(v);
    else if (k === 'tax_year' || k === 'fiscal_year') vs = timeLabel({ [k]: v });
    else if (typeof v === 'object') vs = prettyValue(v);
    else vs = String(v);
    if (vs) parts.push(`${KL[k]}：${vs}`);
  }
  return parts.join('　');
}

function splitTitle(s: any): string {
  return s && s.target && s.target.kind && kindMeta(s.target.kind) ? kindTitle(s.target.kind) : questionText({ ...s, kind: s && s.target && s.target.kind });
}

export function questionText(q: any): string {
  const t = q.target || {};
  const A = t.person ? personName(t.person) : '';
  const B = t.other_person ? personName(t.other_person) : '';
  switch (q.kind) {
    case '判断.生計を一にする': return `${A}さんと${B}さんは、生計を一にしていますか？`;
    case '判断.同居を常況': return `${A}さんと${B}さんは、ふだん同居していますか？`;
    case '選択.扶養の所属': return `${A}さんを、だれの扶養に入れますか？`;
    case '判断.事業と称するに至る程度': return `${A}さんの仕事は「事業」と言える規模ですか？`;
    case '判断.自己の勤労に基づく': return `${A}さんの所得は、本人が働いて得たものですか？`;
    case '判断.家内労働者等': return `${A}さんは家内労働者等に当たりますか？`;
    case '判断.業務関連性': return 'この支出は仕事に関係していますか？';
    case '判断.医療費の範囲': return 'この支払は医療費控除の対象になる医療費ですか？';
    case '見込み.年間収入': return `${A}さんの今後1年の収入の見込みはいくらですか？`;
    default: break;
  }
  if (q.means === '事実') {
    const what = kindWords(t.入力 || String(q.id || '').split(':')[1]).split('か').filter(Boolean)[0] || '記録';
    const on = t.賦課期日 || t.on;
    return `${A ? `${A}さんの` : ''}${what}を入力してください${on ? `（${jpDate(on)}時点）` : ''}`;
  }
  if (q.means === '注入') return 'お住まいの市区町村の税率・保険料率を設定してください';
  if (q.means === '一次情報') return t.title || t.rounding || '端数の扱い';
  if (q.means === '公表待ち') return '国の発表待ち';
  return q.kind && kindMeta(q.kind) ? kindTitle(q.kind) : (MEANS[q.means] || {}).label || '質問';
}

// ------------------------------------------------------------------ 本人に聞く（招待リンク）
// アカウントのない本人に、リンクで答えてもらえる質問（選んで答える判断）
function askable(q: any): string[] {
  if (q.means !== '判断' || !(q.candidates || []).length) return [];
  return (q.persons || []).filter((pid: string) => {
    const p = S.persons.find((x) => x.person_id === pid);
    return p && !p.has_account && (p.is_mine || S.me.role === 'admin');
  });
}

type InviteInput = { one: boolean; email: string; days: number };

// 依頼の入力。値は外の入れ物（io）にも写す（モーダルの「リンクを作る」が読む）
function InviteBody({ name, q, io }: { name: string; q: any; io: InviteInput }) {
  const [one, setOne] = useState(io.one);
  const [email, setEmail] = useState(io.email);
  const [days, setDays] = useState(io.days);
  return (
    <div className="stack">
      {q ? (
        <div className="checks">
          <label><input type="radio" name="inv-scope" checked={one} onChange={() => { io.one = true; setOne(true); }} />{' この質問だけ'}</label>
          <label><input type="radio" name="inv-scope" checked={!one} onChange={() => { io.one = false; setOne(false); }} />{` ${name}さんあての質問すべて`}</label>
        </div>
      ) : null}
      <div className="field"><label>メール</label>
        <input type="email" className="in" placeholder="メールアドレス（任意）" autoComplete="off" value={email} onChange={(e) => { io.email = e.target.value; setEmail(e.target.value); }} />
        <div className="hint">入れると、そのメールで本人確認できた人だけが答えられます</div></div>
      <div className="field"><label>期限</label>
        <select className="in" style={{ width: 'auto' }} value={days} onChange={(e) => { io.days = Number(e.target.value); setDays(Number(e.target.value)); }}>
          {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{`${d}日`}</option>)}
        </select></div>
    </div>
  );
}

export async function openInvite(pid: string, q?: any): Promise<void> {
  const name = personName(pid);
  const io: InviteInput = { one: !!q, email: '', days: 7 };
  const res = await modal<any>(`${name}さんに聞く`, <InviteBody name={name} q={q} io={io} />, [{ label: 'やめる', value: null }, { label: 'リンクを作る', kind: 'primary', run: async () => {
    return post('/api/invites', { person_id: pid, email: io.email.trim() || undefined, days: Number(io.days), question_ids: q && io.one ? [q.id] : [] });
  } }]);
  if (!res) return;
  const url = `${location.origin}${res.path}`;
  const canShare = typeof navigator.share === 'function';
  await modal('リンクができました', (
    <div className="stack">
      <p style={{ margin: 0 }}>{`LINE などで${name}さんに送ってください。1回だけ使えます。`}</p>
      <div className="invite-link">
        <input className="in" readOnly value={url} onClick={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => copyText(url)}><Icon name="copy" size={14} />コピー</button>
        {canShare ? <button type="button" className="btn primary" onClick={() => { navigator.share({ title: `${name}さんへの質問`, text: `${name}さん、税金・扶養の質問に答えてください`, url }).catch(() => {}); }}><Icon name="send" size={14} />送る</button> : null}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: '12.5px' }}>{`期限：${String(res.expires_at || '').slice(0, 10)}。依頼の一覧（設定 → 依頼）から取り消せます。`}</p>
    </div>
  ), [{ label: '閉じる', value: true, kind: 'primary' }]);
}

// ------------------------------------------------------------------ 決めること
const ORDER = ['判断', '事実', '注入', '一次情報', '公表待ち'];

// 答えごとの値。ほかの質問しだいで値がいくつかあるときは、いちばん小さい〜大きいを出す（値は丸めない）
function EffValue({ list }: { list: any[] }) {
  const nums = list.map((x) => (/^-?[\d,]+円?$/.test(String(x)) ? Number(String(x).replace(/[,円]/g, '')) : NaN));
  if (list.length > 1 && nums.every((n) => !Number.isNaN(n))) {
    const unit = list.some((x) => String(x).endsWith('円')) ? '円' : '';
    const lo = Math.min(...nums).toLocaleString('ja-JP');
    const hi = Math.max(...nums).toLocaleString('ja-JP');
    return <b className="eff-val" title={list.join(' / ')}>{lo === hi ? `${lo}${unit}` : `${lo}〜${hi}${unit}`}{lo === hi ? null : <small className="muted">ほかの答えしだい</small>}</b>;
  }
  return <b className="eff-val">{list.join(' / ')}</b>;
}

function EffectsList({ q, cand }: { q: any; cand: any }) {
  const rows: any[] = q.affects.filter((a: any) => a.per_candidate && a.per_candidate[String(cand)]).sort((a: any, b: any) => (b.key - a.key)).slice(0, 3);
  if (!rows.length) return null;
  const years = new Set(rows.map((a) => timeLabel(a.time)));
  return (
    <ul className="c-effects">
      {rows.map((a, i) => (
        <li key={i}>
          <span><span className="eff-who"><Avatar id={a.person} name={personName(a.person)} small /></span>
            <span className="eff-name">{conceptLabel(a.concept).replace(/の額$/, '')}{years.size > 1 ? <small className="muted">{timeLabel(a.time)}</small> : null}</span></span>
          <EffValue list={a.per_candidate[String(cand)]} />
        </li>
      ))}
    </ul>
  );
}

type AnswerIo = { note: string; setErr: (n: ReactNode) => void };

// 回答の保存のダイアログの中身（メモとエラーは中の state。保存の処理は io から読む・書く）
function AnswerBody({ lk, tmpl, cand, form, io }: { lk: any; tmpl: any; cand: any; form: RefObject<FormHandle | null>; io: AnswerIo }) {
  const me = useS((s) => s.me);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<ReactNode>(null);
  useEffect(() => { io.setErr = setErr; }, [io]);
  const fields = fieldsForLedger(lk);
  return (
    <div className="stack">
      <div className="note undet"><Icon name="flag" size={16} />{`${me.user.display_name}さんの回答として保存します`}</div>
      {cand !== null ? <p style={{ margin: 0 }}>回答：<b>{candLabel(cand)}</b></p> : null}
      <RecordForm ref={form} fields={fields} main={fields.map((f: any) => f.path)} initial={tmpl.record} ctx={formCtx()} />
      <div className="field"><label>メモ（任意）</label><input type="text" className="in" placeholder="例：学費と生活費を仕送りしている" value={note} onChange={(e) => { io.note = e.target.value; setNote(e.target.value); }} /></div>
      <div>{err}</div>
    </div>
  );
}

function Questions({ d, meansArg }: { d: any; meansArg: string | undefined }) {
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('okura.skipped') || '[]')));
  const all: any[] = ORDER.flatMap((m) => d.questions.filter((q: any) => q.means === m));
  const [idx, setIdx] = useState(() => {
    const wantId = meansArg && meansArg.startsWith('q:') ? meansArg.slice(2) : null;
    const i = wantId ? Math.max(0, all.findIndex((q) => q.id === wantId)) : Math.max(0, all.findIndex((q) => q.means === (meansArg || '判断') && !skipped.has(q.id)));
    return i < 0 || !all.length ? 0 : i;
  });
  const [choice, setChoice] = useState<any>(null);
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const move = (i: number) => { setIdx(i); setChoice(null); };

  const answer = async (q: any, cand: any) => {
    let res: any;
    try { res = await get(`/api/results/latest/question?id=${encodeURIComponent(q.id)}`); } catch (e) { errorToast(e); return; }
    const tmpl: any = res.templates[String(cand)] || res.templates._ || Object.values(res.templates)[0];
    if (!tmpl) { toast('この質問は記録の画面から入力してください', 'bad'); return; }
    await loadRecords();
    const lk = kindMeta(tmpl.record.kind);
    const form = createRef<FormHandle>();
    const io: AnswerIo = { note: '', setErr: () => {} };
    const ok = await modal<boolean>(lk.title, <AnswerBody lk={lk} tmpl={tmpl} cand={cand} form={form} io={io} />, [{ label: 'キャンセル', value: false }, { label: '保存', kind: 'primary', run: async () => {
      const { value, errors } = form.current!.read();
      if (errors.length) { toast('入力エラーがあります', 'bad'); return false; }
      value.kind = lk.kind;
      if (lk.mark) value.mark = lk.mark;
      try { await post('/api/judgments', { section: tmpl.section, record: value, basis_note: io.note || undefined }); return true; }
      catch (e) { if (e instanceof ApiError) io.setErr(<div className="note bad">{e.message}<ProblemsList detail={e.detail} /></div>); throw e; }
    } }]);
    if (ok) {
      toast('保存しました');
      await refreshStatus();
      setAnswered((s) => new Set([...s, q.id]));
      move(Math.min(all.length - 1, idx + 1));
    }
  };

  const factButton = (q: any, t: any) => {
    const txt = String(t.入力 || '');
    const map: Array<[string, string]> = [['resident_record', 'resident_record'], ['住所', 'resident_record'], ['国年', 'national_pension'], ['medical_insurance', 'medical_insurance'], ['保険', 'medical_insurance'], ['enrollment', 'enrollment'], ['在学', 'enrollment']];
    const id = String(q.id || '');
    const kind = (map.find(([k]) => txt.includes(k) || id.includes(k)) || [])[1];
    if (kind && kindMeta(kind)) {
      const init: any = { roles: {} };
      const km = kindMeta(kind);
      const role = Object.keys(km.roles)[0];
      if (t.person) init.roles[role] = t.person;
      return <button type="button" className="btn primary big" onClick={() => { openRecordForm(km, init, () => { refreshStatus(); }); }}>{`${km.title}を入力`}<Icon name="chevronRight" size={16} /></button>;
    }
    return <Link className="btn primary big" to="/family">入力<Icon name="chevronRight" size={16} /></Link>;
  };

  const rail = (
    <aside className="rail">
      {ORDER.filter((m) => all.some((q) => q.means === m)).map((m) => (
        <Fragment key={m}>
          <div className="r-title" style={{ marginTop: m === ORDER[0] ? 0 : '18px' }}>{(MEANS[m] || {}).label || m}</div>
          <ol>
            {all.map((q, i) => (q.means !== m ? null : (
              <li key={q.id} className={`${i === idx ? 'on' : ''} ${answered.has(q.id) ? 'done' : ''}`} onClick={() => move(i)}>
                {answered.has(q.id) ? <Icon name="check" size={13} /> : skipped.has(q.id) ? <span className="muted">（あとで）</span> : null}
                {questionText(q).replace(/？$/, '').slice(0, 26)}
              </li>
            )))}
          </ol>
        </Fragment>
      ))}
    </aside>
  );

  let pane: ReactNode;
  if (!all.length) {
    pane = <div className="card empty"><Icon name="checkCircle" size={32} /><b>質問はありません</b></div>;
  } else {
    const q = all[idx];
    const t = q.target || {};
    const info = MEANS[q.means] || {};
    const persons: string[] = q.persons || [];
    let bodyEls: ReactNode = null;
    let footEls: ReactNode = null;
    if (q.means === '判断' && q.candidates && q.candidates.length) {
      bodyEls = q.candidates.map((c: any, k: number) => (
        <button type="button" key={k} className={`choice ${choice === c ? 'on' : ''}`} onClick={() => setChoice(c)}>
          <span className="radio" />
          <div style={{ flex: 1 }}><div className="c-title">{candLabel(c)}</div><EffectsList q={q} cand={c} /></div>
        </button>
      ));
      footEls = <button type="button" className="btn primary big" disabled={choice === null} onClick={() => { answer(q, choice); }}>次へ<Icon name="chevronRight" size={16} /></button>;
    } else if (q.means === '判断') {
      bodyEls = <div className="card"><p style={{ margin: 0 }}>金額を入力してください</p></div>;
      footEls = <button type="button" className="btn primary big" onClick={() => { answer(q, null); }}>入力<Icon name="chevronRight" size={16} /></button>;
    } else if (q.means === '事実') {
      footEls = factButton(q, t);
    } else if (q.means === '注入') {
      footEls = <Link className="btn primary big" to={`/settings/injections/${encodeURIComponent(t.point || '')}/${encodeURIComponent((t.issuer || {}).kind || t.issuer_kind || '')}/${encodeURIComponent((t.issuer || {}).code || t.issuer_code || '')}`}>設定<Icon name="chevronRight" size={16} /></Link>;
    } else {
      bodyEls = (
        <>
          <div className="note" style={{ marginBottom: '12px' }}><Icon name="info" size={16} />{q.means === '公表待ち' ? '国の発表後に計算できます' : '金額は幅で表示しています'}</div>
          {(q.candidates || []).map((c: any, k: number) => (
            <div key={k} className="choice" style={{ cursor: 'default' }}><div style={{ flex: 1 }}><div className="c-title">{String(c)}</div><EffectsList q={q} cand={c} /></div></div>
          ))}
        </>
      );
    }
    pane = (
      <>
        <div className="q-eyebrow"><span className={`chip ${info.chip || ''}`}>{info.label || q.means}</span>{`${idx + 1} / ${all.length}`}
          {persons.map((p) => <span key={p} className="row" style={{ gap: '4px' }}><Avatar id={p} name={personName(p)} small /></span>)}</div>
        <h1>{questionText(q)}</h1>
        {bodyEls}
        <div className="why"><Icon name="info" size={15} />{` 回答で ${q.affects_count} 項目の計算が決まります`}
          {q.not_evaluated_reason ? <div className="muted" style={{ marginTop: '6px' }}>ほかの質問に答えると、金額が表示されます</div> : null}</div>
        <div className="q-foot">
          <button type="button" className="btn ghost" disabled={idx === 0} onClick={() => move(idx - 1)}><Icon name="chevronLeft" size={16} />戻る</button>
          <button type="button" className="btn ghost" onClick={() => {
            const next = new Set([...skipped, q.id]);
            localStorage.setItem('okura.skipped', JSON.stringify([...next]));
            setSkipped(next);
            move(Math.min(all.length - 1, idx + 1));
          }}>スキップ</button>
          {askable(q).map((pid) => <button type="button" key={pid} className="btn ghost" onClick={() => { openInvite(pid, q); }}><Icon name="send" size={15} />{`${personName(pid)}さんに聞く`}</button>)}
          <button type="button" className="btn ghost" onClick={() => { openAgent(`「${questionText(q)}」の答えごとの違いを教えて`); }}><Icon name="sparkles" size={15} />AIに質問</button>
          <div className="grow" />
          {footEls}
        </div>
        {t.purpose || t.説明 ? (
          <Details key={q.id} style={{ marginTop: '16px' }} summary="くわしく" summaryStyle={{ fontSize: '12px', cursor: 'pointer' }}>
            <p className="muted" style={{ fontSize: '12.5px' }}>{kindWords(t.purpose || t.説明) || ''}</p>
          </Details>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Link className="back-link" to="/tax"><Icon name="chevronLeft" size={15} />確定申告</Link>
      <StaleNote />
      <div className="interview">{rail}<div className="qpane">{pane}</div></div>
    </>
  );
}

/** 道：/questions/:means?（:means は 判断・事実 などか、古い形の q:<質問のID>） */
export function QuestionsPage() {
  const { means } = useParams();
  const meta = useMeta();
  const d = useDigest();
  const hash = useS((s) => (s.latest && s.latest.result ? s.latest.result.hash : ''));
  if (!meta) return <Skeleton />;
  if (!d) return <NoResult title="質問" />;
  // 結果が変わったら・道が変わったら、最初から（古い画面は描き直していた）
  return <Questions key={`${hash}|${means || ''}`} d={d} meansArg={means} />;
}

// 年齢で変わること：これから5年のうちに来るものだけ。人ごと・日付順、同じ年齢はまとめる
const AGE_HORIZON_DAYS = 365 * 5;

function untilText(days: number) {
  if (days < 60) return `あと${days}日`;
  if (days < 365) return `あと${Math.round(days / 30)}か月`;
  return `あと${Math.floor(days / 365)}年`;
}

function AgeCard({ ages, persons }: { ages: any[]; persons: string[] }) {
  const soon = ages.filter((b) => b.boundary_on && b.days_to_boundary >= 0 && b.days_to_boundary <= AGE_HORIZON_DAYS);
  const groups = persons.map((p) => {
    const byAge = new Map<string, { age: any; on: string; days: number; items: Set<string> }>();
    for (const b of soon.filter((x) => x.person === p)) {
      const key = `${b.crossing_age}|${b.boundary_on}`;
      if (!byAge.has(key)) byAge.set(key, { age: b.crossing_age, on: b.boundary_on, days: b.days_to_boundary, items: new Set() });
      const name = conceptLabel(b.concept).replace(/の年齢の(下限|上限)$/, '').replace(/の年齢$/, '');
      const leaving = /未満|以下/.test((b.criterion || {}).comparison || '');
      byAge.get(key)!.items.add(`${name}${leaving ? 'でなくなる' : 'になる'}`);
    }
    return { p, rows: [...byAge.values()].sort((a, b) => a.days - b.days) };
  }).filter((g) => g.rows.length);
  return (
    <div className="card"><h3 style={{ marginTop: 0 }}>年齢で変わること（5年以内）</h3>
      {groups.length ? groups.map((g) => (
        <div className="age-person" key={g.p}>
          <div className="row" style={{ gap: '8px', marginBottom: '6px' }}><Avatar id={g.p} name={personName(g.p)} small /><b>{personName(g.p)}</b></div>
          {g.rows.map((r) => (
            <div className="age-row" key={`${r.age}|${r.on}`}>
              <span className="age-pill">{`${r.age}歳`}</span>
              <div className="age-what">{[...r.items].map((t) => <div key={t}>{t}</div>)}</div>
              <div className="age-when"><div>{jpDate(r.on)}</div><small className="muted">{untilText(r.days)}</small></div>
            </div>
          ))}
        </div>
      )) : <p className="muted" style={{ margin: 0 }}>ありません</p>}
    </div>
  );
}

// ------------------------------------------------------------------ 値の詳細（根拠・使った記録・境目）
function ValueBody({ v, close }: { v: any; close: () => void }) {
  const u = v.undetermined;
  return (
    <div className="stack">
      <div className="row"><span className="big-value">{v.display ?? (u ? '未確定' : v.out_of_scope ? '未対応' : '—')}</span><StateChips states={v.states} /></div>
      <div className="muted">{`${personName(v.person)}・${timeLabel(v.time)}・${conceptLabel(v.concept)}`}</div>
      {v.filing_item ? <span className="chip info">申告書に載る値</span> : null}
      {v.out_of_scope ? <div className="note"><b>未対応：</b>{v.out_of_scope.reason}</div> : null}
      {u ? (
        <>
          <h3>未確定の理由</h3>
          {u.splits.map((s: any, i: number) => (
            <div className="basis" key={i}>
              <div className="b-name"><span className={`chip ${(MEANS[s.means] || {}).chip || ''}`}>{(MEANS[s.means] || {}).label || s.means}</span>{' '}{splitTitle(s)}</div>
              <div className="muted">{targetText(s.target)}</div>
              <div>回答：{(s.candidates || []).map(candLabel).join('／') || '入力で決まる'}</div>
            </div>
          ))}
          {v.outcomes_display && v.outcomes_display.length ? (
            <>
              <h3>回答ごとの金額</h3>
              <div className="table-wrap"><table className="t">
                <thead><tr><th>回答</th><th>金額</th></tr></thead>
                <tbody>
                  {v.outcomes_display.slice(0, 40).map((o: any, i: number) => (
                    <tr key={i}>
                      <td>{Object.entries<any>(o.conditions).map(([k, c]) => `${splitTitle(u.splits.find((s: any) => s.id === k) || { id: k })}：${candLabel(c)}`).join('、')}</td>
                      <td className="num">{o.display}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          ) : <p className="muted">ほかの質問に答えると表示されます</p>}
          <Link className="btn" to="/questions">質問に回答</Link>
        </>
      ) : null}
      <h3>根拠</h3>
      {v.basis_entries.length ? v.basis_entries.map((b: any, i: number) => (
        <div className="basis" key={i}>
          <div className="b-name">{b.name}{' '}{b.source_kind ? <span className="chip">{b.source_kind}</span> : null}{(b.flags || []).map((f: string, k: number) => <span key={k} className="chip warn" style={{ marginLeft: '4px' }}>{f}</span>)}</div>
          {b.law ? <div>{b.law}</div> : null}
          {b.value !== undefined && b.value !== null ? <div>値：{prettyValue(b.value)}</div> : null}
          {b.effective_from ? <div className="muted">{`適用開始 ${b.effective_from}${b.enforced_on ? `・施行 ${b.enforced_on}` : ''}`}</div> : null}
          {(b.references || []).length ? (
            <div className="muted mono" style={{ fontSize: '.75rem' }}>
              {b.references.map((r: string, k: number) => <Fragment key={k}>{/^https?:/.test(r) ? <a href={r} target="_blank" rel="noopener noreferrer">{r}</a> : `okura-gov/${r}`}{' '}</Fragment>)}
            </div>
          ) : null}
        </div>
      )) : <p className="muted">—</p>}
      <h3>使った記録</h3>
      {v.facts_detail && v.facts_detail.length ? (
        <div className="table-wrap"><table className="t"><tbody>
          {v.facts_detail.map((f: any, i: number) => (
            <tr key={i}>
              <td>{f.visible ? <Link to={`/records/${encodeURIComponent(f.id)}`}>{kindTitle(f.kind)}</Link> : <span className="muted">非公開</span>}</td>
              <td><code>{f.id}</code></td>
              <td>{(f.evidence || []).map((eid: string) => <Link key={eid} to={`/evidence/${eid}`} style={{ marginRight: '6px' }}>書類</Link>)}</td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <p className="muted">—</p>}
      {v.boundaries && v.boundaries.length ? (
        <>
          <h3>壁</h3>
          {v.boundaries.map((b: any, i: number) => <WallView key={i} b={b} />)}
        </>
      ) : null}
      {v.depends && v.depends.length ? (
        <>
          <h3>{`内訳（${v.depends.length}）`}</h3>
          <div className="table-wrap"><table className="t"><tbody>
            {v.depends.slice(0, 60).map((x: any, i: number) => (
              <tr key={i} className="click" onClick={() => { close(); openValue(x.value_id); }}>
                <td>{conceptLabel(x.concept || x.value_id)}</td><td>{personName(x.person)}</td><td className="num">{x.display ?? <StateChips states={x.states} />}</td>
              </tr>
            ))}
          </tbody></table></div>
        </>
      ) : null}
      <Details summary="ID" summaryStyle={{ cursor: 'pointer' }}><code>{v.id}</code></Details>
    </div>
  );
}

export async function openValue(vid: string): Promise<void> {
  const L = S.latest;
  if (!L || !L.result) return;
  let v: any;
  try { v = await get(`/api/results/${L.result.hash}/value?id=${encodeURIComponent(vid)}`); } catch (e) { errorToast(e); return; }
  openDrawer(conceptLabel(v.concept), (close) => <ValueBody v={v} close={() => close()} />);
}

// ------------------------------------------------------------------ その人のページ（ホームの家族のカードから）
/** 道：/person/:pid */
export function PersonPage() {
  const { pid = '' } = useParams();
  useMeta();
  const persons = useS((s) => s.persons);
  const d = useDigest();
  const person = (persons || []).find((x) => x.person_id === pid);
  if (!person) return <div className="card empty"><b>この人は見つかりません</b></div>;
  const age = ageOn(person.birth_on, today());
  const head = (
    <div className="person-hero"><Avatar id={pid} name={person.display_name} />
      <div><h1>{person.display_name}</h1><div className="muted">{[age !== null ? `${age}歳` : '', person.is_me ? 'あなた' : ''].filter(Boolean).join('・')}</div></div></div>
  );
  // その人の書類（見返す入口）と、家族の情報への入口
  const links = (
    <>
      <div className="row" style={{ gap: '8px', flexWrap: 'wrap', margin: '4px 0 16px' }}>
        <Link className="btn" to="/family"><Icon name="users" size={15} />家族の情報</Link>
      </div>
      <PersonDocs pid={pid} />
    </>
  );
  if (!d) return <>{head}{links}<div className="card empty"><b>まだ計算していません</b></div></>;
  if (!d.persons.includes(pid)) return <>{head}{links}<div className="card empty"><Icon name="lock" size={26} /><b>非公開</b><div className="muted">本人が数字の共有をしていません</div></div></>;
  // 申告の状況（年分ごと）：金額と根拠は申告の③にだけ置く（1つのものの正本は1か所）
  const years: number[] = [...new Set<number>(d.times.filter((t: any) => t.time.tax_year).map((t: any) => t.time.tax_year))].sort().reverse();
  const qs: any[] = d.questions.filter((q: any) => (q.persons || []).includes(pid));
  const year = new Date().getFullYear();
  // 壁：同じ壁は1つだけ（年分の値を先に、なければ判定日の値）
  const seen = new Set<string>();
  const walls: any[] = d.boundaries.filter((b: any) => b.person === pid && (b.time.tax_year === year || b.time.on))
    .sort((a: any, b: any) => (a.time.tax_year ? 0 : 1) - (b.time.tax_year ? 0 : 1) || Math.abs(a.difference) - Math.abs(b.difference))
    .filter((b: any) => (seen.has(b.concept) ? false : (seen.add(b.concept), true))).slice(0, 4);
  return (
    <>
      {head}{links}
      {walls.length ? <div className="card"><h3 style={{ marginTop: 0 }}>壁</h3>{walls.map((b) => <WallView key={b.concept} b={b} />)}</div> : null}
      <div className="card flush"><div className="card-head"><h3>確定申告</h3></div>
        {years.map((y) => {
          const vals = d.key_values.filter((v: any) => v.person === pid && timeKey(v.time) === `Y${y}`);
          const undet = vals.filter((v: any) => (v.states || []).includes('未確定')).length;
          const n = qs.filter((q) => !q.years || q.years.includes(y)).length;
          return (
            <Link className="q-row" key={y} to={`/tax/${y}/${encodeURIComponent(pid)}`}>
              <b>{`令和${y - 2018}年分`}</b><span className="grow" />
              {n ? <span className="chip undet">{`決めること ${n}`}</span> : null}
              {undet ? <span className="chip">{`未確定 ${undet}`}</span> : <span className="chip ok">確定</span>}
              <Icon name="chevronRight" size={15} cls="muted" />
            </Link>
          );
        })}
      </div>
      <AgeCard ages={d.age_boundaries.filter((b: any) => b.person === pid)} persons={[pid]} />
    </>
  );
}

// ------------------------------------------------------------------ 申告書に写す
function FormRow({ x, k }: { x: any; k: string }) {
  const [copied, setCopied] = useState(() => localStorage.getItem(k) === '1');
  // 欄の名前：作成コーナーの階層（「保険料等/⑮生命保険料/…/支払保険料等の計」）の最後を大きく、上の階層を小さく。内部の欄のコードは出さない
  const path = String(x.name || x.position || '').split('/').map((s) => s.trim()).filter((s) => s && s !== '見出し' && s !== 'null');
  const main = path.length ? path[path.length - 1] : '';
  const crumbs = path.slice(0, -1).join(' › ');
  const has = x.value !== null && x.value !== undefined && x.value !== '';
  const shown = !has ? '' : (x.value_type === '金額' || typeof x.value === 'number') ? Number(x.value).toLocaleString('ja-JP') : String(x.value);
  return (
    <div className={`ff-row ${copied ? 'copied' : ''}`}>
      <label className="ff-check"><input type="checkbox" checked={copied} aria-label="写した" onChange={(e) => { localStorage.setItem(k, e.target.checked ? '1' : '0'); setCopied(e.target.checked); }} /></label>
      <div className="ff-name">
        {crumbs ? <small className="muted">{crumbs}</small> : null}
        <span>{x.number != null ? <b className="ff-no">{String(x.number)}</b> : null}{main}</span>
        {x.status !== '出力' ? <span className={`chip ${x.status === '未確定' ? 'undet' : 'oos'}`}>{x.status === '未確定' ? '未確定' : '対象外'}{x.reason ? `：${x.reason}` : ''}</span> : null}
        {(x.marks || []).map((m: any, i: number) => <span key={i} className="chip warn">{typeof m === 'string' ? m : prettyValue(m)}</span>)}
      </div>
      <div className="ff-val">
        <b className="num">{shown}</b>
        {has ? <button type="button" className="btn small icon ghost" title="コピー" aria-label="コピー" onClick={() => { copyText(String(x.value)); }}><Icon name="copy" size={15} /></button> : null}
        {x.value_ids && x.value_ids.length ? <button type="button" className="btn small icon ghost" title="根拠" aria-label="根拠" onClick={() => { openValue(x.value_ids[0]); }}><Icon name="info" size={15} /></button> : null}
      </div>
    </div>
  );
}

function FormsBody({ f, hash, person, year, onlyOut }: { f: any; hash: string; person: string; year: number; onlyOut: boolean }) {
  const [tab, setTab] = useState(0);
  if (!f.ok) {
    return (
      <div className="note warn"><b>表示できません：</b>{f.reason || ''}
        {(f.blocking_value_ids || []).length ? (
          <div style={{ marginTop: '6px' }}>原因：{f.blocking_value_ids.slice(0, 12).map((id: string) => <button type="button" key={id} className="btn small" style={{ margin: '2px' }} onClick={() => { openValue(id); }}>{conceptLabel(id.split(':').pop() || '')}</button>)}</div>
        ) : null}
      </div>
    );
  }
  const key = (form: string, code: string) => `okura.copied.${hash.slice(0, 12)}.${person}.${year}.${form}.${code}`;
  const ft = f.filing_type || {};
  const forms: any[] = (f.forms || []).filter((x: any) => x.use !== false);
  const form = forms[tab];
  const fields: any[] = form ? form.fields.filter((x: any) => !onlyOut || (x.status === '出力' && x.value !== null && x.value !== '') || x.status === '未確定') : [];
  return (
    <>
      {ft && (ft.value || ft.reason) ? <div className={ft.value ? 'note ok' : 'note warn'}>{`申告の種類：${ft.value || '未確定'}`}{ft.reason ? `（${ft.reason}）` : ''}</div> : null}
      {(f.not_produced || []).length ? (
        <Details summary={`使わない書類（${(f.not_produced || []).length}）`} summaryStyle={{ cursor: 'pointer' }}>
          <ul>{f.not_produced.map((n: any, i: number) => <li key={i}>{`${n.form}：${n.reason}`}</li>)}</ul>
        </Details>
      ) : null}
      <div className="tabs">{forms.map((x, i) => <button type="button" key={i} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{x.name}{x.use === null ? ' ？' : ''}</button>)}</div>
      <div>
        {!form ? <div className="empty">書類はありません</div> : (
          <>
            {form.use === null ? <div className="note warn">{`未確定：${form.use_reason || ''}`}</div> : null}
            <div className="ff-list">{fields.map((x, i) => { const k = key(form.form, x.code); return <FormRow key={`${k}|${i}`} x={x} k={k} />; })}</div>
          </>
        )}
      </div>
    </>
  );
}

const FORM_YEARS = [2025, 2026];

function Forms({ d, personArg, yearArg }: { d: any; personArg: string | undefined; yearArg: string | undefined }) {
  const hash: string = useS((s) => s.latest.result.hash);
  const persons: string[] = d.persons;
  // 最初の人・年分（上の戻るリンクは、開いたときの人・年分のまま）
  const [first] = useState(() => ({ person: personArg || (persons.includes(S.me.person_id) ? S.me.person_id : persons[0]), year: Number(yearArg) || 2025 }));
  const [personSel, setPerson] = useState<string>(first.person);
  const [yearSel, setYear] = useState<number>(first.year);
  const [onlyOut, setOnlyOut] = useState(true);
  // 選べる中にないときは、選択欄の先頭になる（古い画面と同じ）
  const person = persons.includes(personSel) ? personSel : (persons[0] ?? '');
  const year = FORM_YEARS.includes(yearSel) ? yearSel : FORM_YEARS[0];
  const path = `/api/results/${hash}/forms?person=${encodeURIComponent(person)}&year=${year}`;
  const q = useApi<any>(path);
  return (
    <>
      <Link className="back-link" to={`/tax/${first.year}/${encodeURIComponent(first.person)}/forms`}><Icon name="chevronLeft" size={15} />{`確定申告（${personName(first.person)}・令和${first.year - 2018}年分）`}</Link>
      <div className="page-head"><div className="grow"><h1>申告書</h1>
        <p className="lead">欄ごとの金額を、確定申告書等作成コーナーに入力します</p></div></div>
      <div className="row" style={{ margin: '12px 0' }}>
        <select className="in" style={{ width: 'auto' }} value={person} onChange={(e) => setPerson(e.target.value)}>{persons.map((p) => <option key={p} value={p}>{personName(p)}</option>)}</select>
        <select className="in" style={{ width: 'auto' }} value={year} onChange={(e) => setYear(Number(e.target.value))}>{FORM_YEARS.map((y) => <option key={y} value={y}>{`令和${y - 2018}年分`}</option>)}</select>
        <label><input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} />{' 入力する欄だけ'}</label>
        <a className="btn" href="https://www.keisan.nta.go.jp/" target="_blank" rel="noopener noreferrer">作成コーナー<Icon name="external" size={14} /></a>
      </div>
      <StaleNote />
      <div>
        {q.data !== undefined ? <FormsBody key={path} f={q.data} hash={hash} person={person} year={year} onlyOut={onlyOut} />
          : q.error ? <div className="note">{q.error.message}</div>
            : <p className="muted"><span className="spinner" />{' 読み込み中…'}</p>}
      </div>
    </>
  );
}

/** 道：/forms/:person?/:year? */
export function FormsPage() {
  const { person, year } = useParams();
  const d = useDigest();
  if (!d) return <NoResult title="申告書" />;
  return <Forms key={`${person || ''}|${year || ''}`} d={d} personArg={person} yearArg={year} />;
}

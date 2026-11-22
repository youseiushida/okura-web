// 書類（受信箱）・写真と入力の分割画面・確認待ち（提案）
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { post, ApiError } from '../lib/api';
import { QUICK, RecordForm, fieldsForRecord, fieldsForLedger, recordSummary, recordDate, type FormHandle } from '../lib/forms';
import { originLabel, enumLabel, conceptLabel } from '../lib/labels.js';
import { refreshStatus } from '../lib/status';
import { postChecked } from '../lib/writes';
import { S, useS, loadMeta, loadRecords, personName, kindMeta, kindTitle, formCtx } from '../lib/store';
import { useApi } from '../lib/useApi';
import { Icon } from '../ui/Icon';
import { Avatar, ErrorNote, ProblemsList, Skeleton } from '../ui/bits';
import { toast, errorToast, modal, openDrawer, confirmBox, askText } from '../ui/overlay';
import { DocList, docFacts, docGivenName, docKindName, docTitle, evStatus, shareDoc, useDocRecords } from './Docs';
import { isPersonProposal, personProposalLine, reviewPersonProposal } from './personProposal';
import { isSettingProposal, settingTitle, settingLine, reviewSettingProposal, SettingBody, acceptSettingProposal } from './settingProposal';

const enc = encodeURIComponent;

function StatusChip({ e }: { e: any }) {
  const s = evStatus(e);
  if (s === 'new') return <span className="chip warn">未登録</span>;
  if (s === 'pending') return <span className="chip unverified">確認待ち</span>;
  if (s === 'done') return <span className="chip ok">登録済み</span>;
  return <span className="chip">参考資料</span>;
}

/** 語彙（記録の種類）と記録を取り直してから中身を出す（古い画面の loadMeta → loadRecords(true)）。key が変わるたびに取り直す */
// 記録の ID を画面の言葉に（種類の名前）。一覧にまだなければ「記録」
function recordName(rid: string): string {
  const hit = (S.records || []).find((r: any) => (r.record || r).id === rid);
  return hit ? kindTitle((hit.record || hit).kind) : '記録';
}

function useFreshRecords(key: string) {
  const meta = useS((s) => s.meta);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([loadMeta(), loadRecords(true)]).then(
      () => { if (alive) { setError(null); setDone(key); } },
      (e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [key]);
  return { ready: !!meta && done === key, error };
}

// ------------------------------------------------------------------ 書類
export function UploadPage() {
  const { owner } = useParams();
  const q = useApi('/api/evidence');
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <Skeleton />;
  return <UploadView key={owner || ''} ev={q.data} ownerArg={owner} />;
}

// 書類の画面：家族の書類を見返す場所（だれの・何の・いつの、で探す）。追加はいつでも上のボタンから
const STATUS_FILTERS: Array<[string, string]> = [['', 'すべて'], ['new', '未登録'], ['pending', '確認待ち'], ['ignored', '参考資料']];

function UploadView({ ev, ownerArg }: { ev: any; ownerArg?: string }) {
  const navigate = useNavigate();
  const persons = useS((s) => s.persons);
  const records = useDocRecords();
  // 絞り込み：人（道の /upload/<人> で最初から絞れる）・種類・状態・ことば
  const [who, setWho] = useState<string>(() => (ownerArg && persons.some((x) => x.person_id === ownerArg) ? ownerArg : ''));
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [progress, setProgress] = useState('');
  const [over, setOver] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  // 追加する書類の持ち主：人で絞っていればその人、いなければ自分（あとで書類の画面で変えられる）
  const owner = who || S.me.person_id;
  const sel = useRef({ owner });
  sel.current = { owner };

  async function upload(files: File[]) {
    const ids: string[] = [];
    let i = 0;
    for (const f of files) {
      i++;
      setProgress(`アップロード中 ${i}/${files.length}…`);
      try {
        const buf = await f.arrayBuffer();
        const r = await post(`/api/evidence?owner=${enc(sel.current.owner)}`, undefined, { raw: buf, contentType: f.type || 'application/octet-stream' });
        if (r.duplicate) toast('同じ書類はアップロード済みです');
        ids.push(r.id);
      } catch (e) { errorToast(e); }
    }
    setProgress('');
    if (fileIn.current) fileIn.current.value = ''; // 同じファイルをもう一度選べるように
    if (ids.length) {
      toast(`${ids.length}件アップロードしました`);
      await refreshStatus();
      if (ids.length === 1) navigate(`/evidence/${ids[0]}`);
      else setStatus('new'); // 一覧は書き込みのあとに自動で取り直される
    }
  }
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // 貼り付け（クリップボードの画像）。この画面を開いているあいだだけ
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); uploadRef.current(files); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const all: any[] = ev.evidence;
  const ofWho = all.filter((e) => !who || e.owner_person === who);
  // 種類の絞り込みは、いまある書類の種類だけを出す
  const kinds = [...new Set(ofWho.map((e) => docKindName(e, records)))].sort((x, y) => (x === '未分類' ? 1 : y === '未分類' ? -1 : x.localeCompare(y, 'ja')));
  const word = text.trim();
  const list = ofWho.filter((e) => (!kind || docKindName(e, records) === kind) && (!status || evStatus(e) === status)
    && (!word || [docTitle(e, records), docKindName(e, records), personName(e.owner_person), docFacts(e, records).date].some((x) => String(x).includes(word))));
  const todo = ofWho.filter((e) => evStatus(e) === 'new').length;
  const whoName = who ? personName(who) : '';
  return (
    <>
      <div className="page-head keep"><div className="grow"><h1>書類</h1>
        <p className="lead hide-sm">給与明細・源泉徴収票・領収書などを、家族ごとにまとめて見返せます</p></div>
        <button type="button" className="btn primary" onClick={() => fileIn.current?.click()}><Icon name="camera" size={15} />{progress || '追加'}</button></div>
      <input type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }} ref={fileIn}
        onChange={(e) => upload([...(e.currentTarget.files || [])])} />

      <div className="chips-row" role="group" aria-label="人で絞る">
        <button type="button" className={`pchip ${who === '' ? 'on' : ''}`} onClick={() => { setWho(''); setKind(''); }}><Icon name="users" size={14} />全員</button>
        {persons.map((x) => (
          <button type="button" key={x.person_id} className={`pchip ${who === x.person_id ? 'on' : ''}`} onClick={() => { setWho(x.person_id); setKind(''); }}>
            <Avatar id={x.person_id} name={x.display_name} small />{x.display_name}
          </button>
        ))}
      </div>

      <div className={`dropbar hide-sm${over ? ' over' : ''}`} tabIndex={0} role="button" aria-label="書類を選ぶ"
        onClick={() => fileIn.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileIn.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}>
        <div className="d-ico"><Icon name="upload" size={20} /></div>
        <div className="grow"><b>ここにドラッグ＆ドロップ</b>
          <span className="muted" style={{ fontSize: '12.5px' }}>{`写真・PDF。${whoName || 'あなた'}の書類として追加します`}</span></div>
        <span className="muted">{progress}</span>
      </div>

      {todo ? (
        <button type="button" className="band doc-todo" onClick={() => setStatus(status === 'new' ? '' : 'new')}>
          <Icon name="inbox" size={17} /><span>{`未登録の書類 ${todo}件`}</span><small>{status === 'new' ? '絞り込みを解除' : '種類を選んで登録する'}</small><Icon name="chevronRight" size={15} />
        </button>
      ) : null}

      {all.length ? (
        <>
          <input type="search" className="in doc-search" placeholder="種類・名前・日付で探す" value={text} onChange={(e) => setText(e.target.value)} />
          {kinds.length > 1 ? (
            <div className="chips-row" role="group" aria-label="種類で絞る">
              <button type="button" className={`pchip ${kind === '' ? 'on' : ''}`} onClick={() => setKind('')}>すべての種類</button>
              {kinds.map((k) => <button type="button" key={k} className={`pchip ${kind === k ? 'on' : ''}`} onClick={() => setKind(kind === k ? '' : k)}>{k}</button>)}
            </div>
          ) : null}
          <div className="chips-row doc-status" role="group" aria-label="状態で絞る">
            {STATUS_FILTERS.map(([k, label]) => {
              const n = k ? ofWho.filter((e) => evStatus(e) === k).length : ofWho.length;
              if (k && !n) return null;
              return <button type="button" key={k} className={`pchip small ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{label}<span className="count">{String(n)}</span></button>;
            })}
          </div>
        </>
      ) : null}

      {list.length ? <DocList items={list} records={records} showOwner={!who} />
        : (
          <div className="card empty"><Icon name="inbox" size={28} />
            <b>{all.length ? '当てはまる書類がありません' : 'まだ書類がありません'}</b>
            {all.length ? null : <div className="muted">給与明細や源泉徴収票を撮って入れておくと、あとで家族で見返せます</div>}
            <button type="button" className="btn primary" style={{ marginTop: '10px' }} onClick={() => fileIn.current?.click()}><Icon name="camera" size={15} />書類を追加</button>
          </div>
        )}
      {ev.hidden ? <p className="muted" style={{ fontSize: '12.5px', marginTop: '10px' }}>{`ほかに、本人が見せていない書類が${ev.hidden}件あります`}</p> : null}
    </>
  );
}

// ------------------------------------------------------------------ 分割画面
type Cur = { q: any; proposal: any; km: any; initial: any; ai: Set<string>; n: number };

/** 入力欄の中身を作る（種類のボタン q か、確認待ちの提案 proposal から）。種類が使えなければ null */
function makeCur(e: any, q: any, proposal: any, n: number): Cur | null {
  const km = kindMeta(q ? q.kind : proposal.payload.record.kind);
  if (!km) return null;
  const rec = proposal ? proposal.payload.record : {};
  const initial = JSON.parse(JSON.stringify(rec));
  if (!proposal && q) {
    initial.roles = initial.roles || {};
    if (q.roleDefault) initial.roles[q.roleDefault] = e.owner_person;
    if (q.kind === 'medical_payment') initial.roles.patient = initial.roles.patient || e.owner_person;
    if (q.defaults) for (const [k, v] of Object.entries<any>(q.defaults)) initial[k] = { ...(initial[k] || {}), ...v };
  }
  const ai = new Set<string>();
  if (proposal && (proposal.origin === 'ai-ocr' || proposal.origin.startsWith('mcp:') || proposal.origin.startsWith('api:') || proposal.origin === 'inapp-agent')) {
    const walk = (o: any, p: string) => { for (const [k, v] of Object.entries<any>(o || {})) { const path = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path); else ai.add(path); } };
    walk(rec, '');
  }
  return { q, proposal, km, initial, ai, n };
}

/** 開いたときに出す入力欄：確認待ちがあればその提案、なければ書類の種類 */
function firstForm(e: any, mine: any[]): { q: any; proposal: any } | null {
  if (mine.length) return { q: QUICK.find((q: any) => q.kind === mine[0].payload.record.kind) || null, proposal: mine[0] };
  if (e.doc_type) { const q = QUICK.find((x: any) => x.id === e.doc_type); if (q) return { q, proposal: null }; }
  return null;
}

export function EvidencePage() {
  const { eid = '' } = useParams();
  const qe = useApi(`/api/evidence/${enc(eid)}`);
  const qp = useApi('/api/proposals');
  const qa = useApi('/api/evidence');
  const fresh = useFreshRecords(eid);
  // 登録・一時保存・却下・読み取りのあと：取り直してから、画面を最初の状態に戻す（古い画面の描き直し）
  const [round, setRound] = useState(0);
  const reset = async () => {
    await Promise.all([qe.reload(), qp.reload(), qa.reload(), loadRecords(true).catch(() => {})]);
    setRound((r) => r + 1);
  };
  const error = qe.error || qp.error || qa.error || fresh.error;
  if (!qe.data || !qp.data || !qa.data || !fresh.ready) return error ? <ErrorNote error={error} /> : <Skeleton />;
  const mine = qp.data.proposals.filter((p: any) => p.evidence_id === eid);
  return <EvidenceView key={`${eid}:${round}`} eid={eid} e={qe.data} mine={mine} all={qa.data} reset={reset} />;
}

function EvidenceView({ eid, e, mine, all, reset }: { eid: string; e: any; mine: any[]; all: any; reset: () => Promise<void> }) {
  const navigate = useNavigate();
  const persons = useS((s) => s.persons);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [owner, setOwner] = useState<string>(e.owner_person);
  const [onKind, setOnKind] = useState<string>(e.doc_type || '');
  const [cur, setCur] = useState<Cur | null>(() => { const f = firstForm(e, mine); return f ? makeCur(e, f.q, f.proposal, 0) : null; });
  const [err, setErr] = useState<any>(null);
  const form = useRef<FormHandle>(null);
  const seq = useRef(0);
  const warned = useRef(false);
  useEffect(() => {
    if (warned.current) return;
    warned.current = true;
    if (firstForm(e, mine) && !cur) toast('この種類は使えません', 'bad');
    // 開いたときに1度だけ
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fileUrl = `/api/evidence/${enc(eid)}/file`;
  const isImg = e.mime.startsWith('image/') && e.mime !== 'image/heic';
  const idx = all.evidence.findIndex((x: any) => x.id === eid);
  const nextNew = all.evidence.find((x: any) => x.id !== eid && !x.records.length && !x.ignored);
  const prev = idx > 0 ? all.evidence[idx - 1] : null;
  const next = idx >= 0 && idx < all.evidence.length - 1 ? all.evidence[idx + 1] : null;

  function openForm(q: any, proposal: any) {
    const c = makeCur(e, q, proposal, ++seq.current);
    if (!c) { toast('この種類は使えません', 'bad'); return; }
    setErr(null);
    setCur(c);
  }

  async function register() {
    if (!cur || !form.current) return;
    const { proposal } = cur;
    const n = form.current.unverified();
    if (n) { toast(`未チェックの欄が${n}つあります`, 'bad'); return; }
    const { value, errors } = form.current.read();
    if (errors.length) { toast('入力エラーがあります', 'bad'); return; }
    const km = kindMeta(value.kind || (cur.q ? cur.q.kind : proposal.payload.record.kind));
    value.kind = km.kind;
    setErr(null);
    try {
      if (proposal) await postChecked(`/api/proposals/${proposal.id}/accept`, { record: value });
      else await postChecked('/api/records', { section: km.section, record: value, evidence_ids: [eid] });
      toast('登録しました');
      await refreshStatus();
      const again = await modal('登録しました', <p className="muted">同じ書類から続けて登録できます</p>, [
        { label: '続けて登録', value: 'again' }, nextNew ? { label: '次の書類へ', value: 'next', kind: 'primary' } : { label: '一覧に戻る', value: 'list', kind: 'primary' }]);
      if (again === 'next') navigate(`/evidence/${nextNew.id}`);
      else if (again === 'list') navigate('/upload');
      else await reset();
    } catch (e2) {
      errorToast(e2);
      if (e2 instanceof ApiError) setErr(e2);
    }
  }

  async function saveDraft() {
    if (!cur || !form.current) return;
    const { value } = form.current.read();
    const km = kindMeta(cur.q ? cur.q.kind : cur.proposal.payload.record.kind);
    value.kind = km.kind;
    try {
      if (cur.proposal) { toast('一時保存しました'); return; }
      await post('/api/proposals', { kind: 'record', section: km.section, record: value, evidence_id: eid, rationale: '下書き' });
      toast('一時保存しました');
      await refreshStatus();
      await reset();
    } catch (e2) { errorToast(e2); }
  }

  async function rejectProposal() {
    if (!cur || !cur.proposal) return;
    try { await post(`/api/proposals/${cur.proposal.id}/reject`, { note: '読み取りを捨てた' }); toast('却下しました'); await refreshStatus(); await reset(); }
    catch (e2) { errorToast(e2); }
  }

  async function aiRead(ack = false) {
    try {
      toast('読み取り中…');
      const r = await post(`/api/evidence/${enc(eid)}/extract`, ack ? { acknowledge_external: true } : {});
      if (!r.proposal_id) { toast('読み取れませんでした', 'bad'); return; }
      toast('読み取りました。金額を確認してください');
      await refreshStatus();
      await reset();
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === 'ack_required') {
        const ok = await modal('写真を外部の AI に送信しますか？', <p className="muted">送信先のサービスにデータが残ることがあります</p>, [{ label: 'キャンセル', value: false }, { label: '送信', value: true, kind: 'primary' }]);
        if (ok) aiRead(true);
      } else errorToast(e2);
    }
  }

  async function toggleIgnored() {
    const was = e.ignored;
    try {
      await post(`/api/evidence/${enc(eid)}/meta`, { ignored: !was });
      toast(was ? '戻しました' : '参考資料にしました');
      await refreshStatus();
      await reset();
    } catch (e2) { errorToast(e2); }
  }

  async function changeOwner(v: string) {
    setOwner(v);
    try { await post(`/api/evidence/${enc(eid)}/owner`, { owner: v }); toast('変更しました'); } catch (e2) { errorToast(e2); }
  }

  async function chooseAnyKind() {
    const ref = { current: null as HTMLSelectElement | null };
    const kinds = S.meta.records.filter((k: any) => k.section === 'facts' || k.section === 'assets' || k.section === 'filed_documents');
    const kind = await modal<string>('種類を選択',
      <select className="in" ref={(el) => { ref.current = el; }}>{kinds.map((k: any) => <option key={k.kind} value={k.kind}>{k.title}</option>)}</select>,
      [{ label: 'キャンセル', value: null as any }, { label: '選択', kind: 'primary', run: () => (ref.current ? ref.current.value : '') }]);
    if (kind) openForm({ kind, name: kindTitle(kind), icon: 'layers', main: null }, null);
  }

  async function rename() {
    const v = await askText('書類の名前', '何の書類か、あとで見て分かる名前', { placeholder: '例：2026年10月分の給与明細', required: false, initial: docGivenName(e) });
    if (v === null) return;
    try { await post(`/api/evidence/${enc(eid)}/meta`, { label: v || null }); toast(v ? '名前を付けました' : '名前を消しました'); } catch (err) { errorToast(err); }
  }

  async function chooseKind(q: any) {
    setOnKind(q.id);
    openForm(q, null);
    try { await post(`/api/evidence/${enc(eid)}/meta`, { doc_type: q.id }); } catch { /* 表示の分類だけ */ }
  }

  return (
    <>
      <div className="toolbar ev-bar">
        <Link className="btn ghost small" to="/upload"><Icon name="chevronLeft" size={14} />書類</Link>
        <div className="grow" />
        <div className="ev-actions">
          <button type="button" className="btn small" onClick={() => aiRead(false)}><Icon name="sparkles" size={14} />AI読み取り</button>
          <button type="button" className="btn small" onClick={toggleIgnored}>{e.ignored ? '登録する書類に戻す' : '参考資料にする'}</button>
        </div>
        {/* 前後の書類へ：2つを離さない */}
        <div className="ev-pager">
          <button type="button" className="btn small icon" disabled={!prev} title="前の書類" aria-label="前の書類" onClick={() => prev && navigate(`/evidence/${prev.id}`)}><Icon name="chevronLeft" size={15} /></button>
          <button type="button" className="btn small icon" disabled={!next} title="次の書類" aria-label="次の書類" onClick={() => next && navigate(`/evidence/${next.id}`)}><Icon name="chevronRight" size={15} /></button>
        </div>
      </div>
      <div className="split">
        <div className="pane-left">
          <div className="viewer-bar">
            <button type="button" className="btn small icon" title="拡大" onClick={() => setZoom((z) => Math.min(4, z * 1.25))}><Icon name="zoomIn" size={15} /></button>
            <button type="button" className="btn small icon" title="縮小" onClick={() => setZoom((z) => Math.max(0.3, z / 1.25))}><Icon name="zoomOut" size={15} /></button>
            <button type="button" className="btn small icon" title="回転" onClick={() => setRot((r) => (r + 90) % 360)}><Icon name="rotate" size={15} /></button>
            <div style={{ flex: 1 }} />
            <a className="btn small" href={fileUrl} target="_blank" rel="noopener"><Icon name="external" size={14} /><span className="hide-sm">別のタブ</span></a>
            <a className="btn small" href={fileUrl} download={e.label || true}><Icon name="download" size={14} />ダウンロード</a>
            <button type="button" className="btn small" onClick={() => shareDoc(e)}><Icon name="send" size={14} />共有</button>
          </div>
          <div className="viewer">
            {isImg ? <img src={fileUrl} alt="書類の画像" style={zoom !== 1 || rot !== 0 ? { transform: `scale(${zoom}) rotate(${rot}deg)` } : undefined} />
              : e.mime === 'application/pdf' ? <iframe src={fileUrl} title="PDF" />
                : <div style={{ color: '#e7e5e4', padding: '2rem' }}>このファイルは表示できません</div>}
          </div>
        </div>
        <div className="pane-right">
          <div className="pane-body">
            {/* 何の書類か（見返すときの見出し）。ファイル名は出さない。名前は付け直せる */}
            <div className="row between" style={{ marginBottom: '10px', gap: '8px' }}>
              <b style={{ fontSize: '16px', overflowWrap: 'anywhere' }}>{docTitle(e, S.records)}</b>
              <button type="button" className="btn small" onClick={rename}><Icon name="edit" size={14} />{docGivenName(e) ? '名前を変える' : '名前を付ける'}</button>
            </div>
            <div className="row between">
              <div className="row"><StatusChip e={e} />{e.intact ? <span className="chip ok" title={`sha256 ${e.sha256}`}><Icon name="shield" size={12} />保存時のまま</span> : <span className="chip bad">保存したあとにファイルが変わっています</span>}</div>
              <div className="row"><Icon name="users" size={15} cls="muted" />
                <select className="in" style={{ width: 'auto', height: '30px' }} value={owner} onChange={(ev) => changeOwner(ev.target.value)}>
                  {persons.map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
                </select></div>
            </div>
            {e.records.length ? <div className="note ok" style={{ marginTop: '12px' }}><Icon name="checkCircle" size={16} /><div>登録済み：{e.records.map((rid: string) => <Link key={rid} to={`/records/${enc(rid)}`} style={{ marginRight: '8px' }}>{recordName(rid)}</Link>)}</div></div> : null}
            {mine.length ? <div className="note warn" style={{ marginTop: '12px' }}><Icon name="eye" size={16} />{`確認待ち ${mine.length}件`}</div> : null}
            <div className="section-title">種類</div>
            <div className="kinds" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
              {QUICK.map((q: any) => (
                <button type="button" key={q.id} className={`kind-btn ${onKind === q.id ? 'on' : ''}`} onClick={() => chooseKind(q)}>
                  <span className="k-ico"><Icon name={q.icon} size={16} /></span><span className="k-name">{q.name}</span><span className="k-sub">{q.sub}</span>
                </button>
              ))}
              <button type="button" className="kind-btn" onClick={chooseAnyKind}><span className="k-ico"><Icon name="layers" size={16} /></span><span className="k-name">その他</span></button>
            </div>
            <div>
              {cur ? (
                <>
                  <div className="row" style={{ margin: '20px 0 4px' }}><h3 style={{ margin: 0, flex: 1 }}>{cur.q ? cur.q.name : cur.km.title}</h3>
                    {cur.proposal ? <span className="chip unverified">{`${originLabel(cur.proposal.origin)}・確認待ち`}</span> : null}</div>
                  {cur.ai.size ? <div className="note warn" style={{ marginBottom: '14px' }}><Icon name="eye" size={16} />黄色の欄は AI の読み取りです。写真と見比べてチェックしてください</div> : null}
                  <RecordForm key={cur.n} ref={form} fields={fieldsForRecord(cur.km)} initial={cur.initial} main={cur.q ? cur.q.main : null} ctx={formCtx()} ai={cur.ai} sync={cur.q ? cur.q.sync : null} />
                  <div>{err ? <div className="note bad" style={{ marginTop: '12px' }}><Icon name="alert" size={16} /><div>{err.message}<ProblemsList detail={err.detail} /></div></div> : null}</div>
                </>
              ) : null}
            </div>
          </div>
          <div className="pane-foot">
            {cur ? (
              <>
                <button type="button" className="btn primary" onClick={register}><Icon name="check" size={15} />登録</button>
                <button type="button" className="btn" onClick={saveDraft}>一時保存</button>
                <div style={{ flex: 1 }} />
                {cur.proposal ? <button type="button" className="btn ghost danger" onClick={rejectProposal}>却下</button> : null}
              </>
            ) : e.records.length ? null : <span className="muted" style={{ fontSize: '12.5px' }}>種類を選んでください</span>}
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ 確認待ち
function PerCandidateTable({ c }: { c: any }) {
  if (!c || !c.per_candidate || !c.per_candidate.length) return null;
  const cands: any[] = c.candidates || [];
  return (
    <div className="table-wrap" style={{ marginTop: '8px' }}><table className="t">
      <thead><tr><th />{cands.map((x, i) => <th key={i}>{enumLabel(String(x)) === String(x) ? personName(x) || x : enumLabel(String(x))}</th>)}</tr></thead>
      <tbody>{c.per_candidate.map((a: any, i: number) => (
        <tr key={i}><td>{`${personName(a.person)}：${conceptLabel(a.concept)}`}</td>{cands.map((x, k) => <td key={k} className="num">{(a.per_candidate[String(x)] || ['—']).join(' / ')}</td>)}</tr>
      ))}</tbody>
    </table></div>
  );
}

const INBOX_TABS: Array<[string, string]> = [['pending', '確認待ち'], ['accepted', '登録済み'], ['rejected', '却下']];
const PROPOSAL_KIND: Record<string, string> = { record: '記録', judgment: '回答', choice: '回答', forecast: '見込み', person: '家族', delete: '取消し', correct: '訂正', injection: '設定' };

/** 提案の確認（ドロワーの中身）。登録するのは人 */
function ProposalForm({ p, km, close }: { p: any; km: any; close: () => void }) {
  const rec = p.payload.record || {};
  const isLedger = ['judgments', 'choices'].includes(p.payload.section);
  const [fields] = useState<any[]>(() => (isLedger ? fieldsForLedger(km) : fieldsForRecord(km)));
  const [ai] = useState(() => new Set<string>(fields.map((f: any) => f.path)));
  const [initial] = useState(() => JSON.parse(JSON.stringify(rec))); // API から来た値は書き換えない（写し）
  const [note, setNote] = useState<string>(p.rationale || '');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<FormHandle>(null);
  const accept = async () => {
    if (!form.current || busy) return;
    if (form.current.unverified()) { toast(`未チェックの欄が${form.current.unverified()}つあります`, 'bad'); return; }
    const { value, errors } = form.current.read();
    if (errors.length) { toast('入力エラーがあります', 'bad'); return; }
    value.kind = km.kind;
    if (km.mark) value.mark = km.mark;
    setBusy(true);
    try {
      await postChecked(`/api/proposals/${p.id}/accept`, { record: value, basis_note: note || undefined });
      toast('登録しました');
      close();
      await refreshStatus(); // 一覧は書き込みのあとに自動で取り直される
    } catch (e) { setBusy(false); errorToast(e); if (e instanceof ApiError) setErr(e); }
  };
  return (
    <div className="stack">
      <div className="note warn">{isLedger ? 'AI の提案です。回答するのはあなたです' : 'AI の提案です。各欄をチェックしてください'}</div>
      <PerCandidateTable c={p.candidates} />
      <RecordForm ref={form} fields={fields} initial={initial} ctx={formCtx()} ai={ai} />
      {isLedger ? <div className="field"><label>メモ</label><input type="text" className="in" placeholder="メモ（任意）" value={note} onChange={(e) => setNote(e.target.value)} /></div> : null}
      <div>{err ? <div className="note bad">{err.message}<ProblemsList detail={err.detail} /></div> : null}</div>
      <div className="row"><button type="button" className="btn primary big" onClick={accept}>登録</button></div>
    </div>
  );
}

function openProposal(p: any) {
  if (isSettingProposal(p)) { reviewSettingProposal(p).then((ok) => { if (ok) toast('設定しました'); }, errorToast); return; }
  if (isPersonProposal(p)) { reviewPersonProposal(p).then((ok) => { if (ok) toast('登録しました'); }, errorToast); return; }
  const rec = p.payload.record || {};
  const km = kindMeta(rec.kind);
  if (!km) { toast('この種類は使えません', 'bad'); return; }
  if (p.kind === 'delete') {
    // 取消しの提案：中身を確かめて、人が押したときだけ取り消す（消さずに、取消しと理由を追記する）
    confirmBox(`${km.title}を取り消しますか`, [recordDate(rec), recordSummary(rec), p.rationale].filter(Boolean).join('　'), '取り消す', 'danger')
      .then(async (ok) => { if (!ok) return; await post(`/api/proposals/${p.id}/accept`, {}); toast('取り消しました'); await loadRecords(true); await refreshStatus(); })
      .catch(errorToast);
    return;
  }
  openDrawer(p.kind === 'correct' ? `訂正：${km.title}` : km.title, (close) => <ProposalForm p={p} km={km} close={() => close()} />);
}

function ProposalCard({ p, st }: { p: any; st: string }) {
  const persons = useS((s) => s.persons);
  const rec = p.payload.record || {};
  const who = Object.values<any>(rec.roles || rec.subject || {}).filter((v) => typeof v === 'string' && persons.some((x) => x.person_id === v));
  const reject = async () => {
    try { await post(`/api/proposals/${p.id}/reject`, { note: '人が捨てた' }); toast('却下しました'); await refreshStatus(); } catch (e) { errorToast(e); }
  };
  const [busy, setBusy] = useState(false);
  const setting = isSettingProposal(p);
  // 設定の提案は、値と出典をカードにそのまま出す（開かないと値が分からない、をなくす）。押すとそのまま設定する
  const acceptSetting = async () => {
    setBusy(true);
    try { await acceptSettingProposal(p); toast('設定しました'); } catch (e) { errorToast(e); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: 'wrap', gap: '6px' }}>
        <span className="chip unverified">{originLabel(p.origin)}</span>
        <span className="chip">{PROPOSAL_KIND[p.kind] || '提案'}</span>
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: '12.5px' }}>{(p.created_at || '').slice(0, 16).replace('T', ' ')}</span>
      </div>
      <b style={{ display: 'block', marginTop: '8px', overflowWrap: 'anywhere' }}>{isSettingProposal(p) ? settingTitle(p) : isPersonProposal(p) ? '家族を追加' : kindTitle(rec.kind)}</b>
      <div className="muted" style={{ marginTop: '4px' }}>{isSettingProposal(p) ? settingLine(p) : isPersonProposal(p) ? personProposalLine(p) : <>{who.map(personName).join('・')} {recordDate(rec)} {recordSummary(rec)}</>}</div>
      {p.rationale ? <div className="muted" style={{ marginTop: '6px' }}>{p.rationale}</div> : null}
      <PerCandidateTable c={p.candidates} />
      {p.evidence_id ? <Link to={`/evidence/${p.evidence_id}`} className="btn small" style={{ marginTop: '8px' }}><Icon name="receipt" size={14} />書類を表示</Link> : null}
      {setting ? <div className="inbox-setting"><SettingBody pr={p} /></div> : null}
      {st === 'pending' ? (
        <div className="row" style={{ marginTop: '10px' }}>
          {setting ? <button type="button" className="btn primary" disabled={busy} onClick={acceptSetting}><Icon name="check" size={15} />{busy ? '設定中…' : '設定する'}</button>
            : <button type="button" className="btn primary" onClick={() => openProposal(p)}>確認</button>}
          <button type="button" className="btn danger" onClick={reject}>却下</button>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: '6px' }}>{(p.decided_at || '').slice(0, 16).replace('T', ' ')}{p.result_record_id ? <Link to={`/records/${enc(p.result_record_id)}`} style={{ marginLeft: '8px' }}>記録を見る</Link> : null}</div>
      )}
    </div>
  );
}

export function InboxPage() {
  const [st, setSt] = useState('pending');
  const q = useApi(`/api/proposals?status=${st}`);
  const fresh = useFreshRecords('inbox');
  // タブを切り替えたとき、新しい一覧が来るまで前の一覧を（前のタブの形のまま）出しておく
  const [shown, setShown] = useState<{ st: string; r: any } | null>(null);
  if (q.data && (!shown || shown.r !== q.data || shown.st !== st)) setShown({ st, r: q.data });
  const error = q.error || fresh.error;
  return (
    <>
      <div className="page-head"><div className="grow"><h1>確認待ち</h1>
        <p className="lead">AI が読み取った内容・提案。登録するまで計算に入りません</p></div></div>
      <div className="tabs">{INBOX_TABS.map(([k, l]) => <button type="button" key={k} className={st === k ? 'on' : ''} onClick={() => setSt(k)}>{l}</button>)}</div>
      <div className="stack">
        {shown && fresh.ready ? (
          <>
            {shown.r.hidden ? <div className="note">{`非公開 ${shown.r.hidden}件`}</div> : null}
            {shown.r.proposals.length ? shown.r.proposals.map((p: any) => <ProposalCard key={p.id} p={p} st={shown.st} />)
              : <div className="empty">{shown.st === 'pending' ? '要確認はありません' : 'ありません'}</div>}
          </>
        ) : error ? <ErrorNote error={error} /> : <Skeleton />}
      </div>
    </>
  );
}

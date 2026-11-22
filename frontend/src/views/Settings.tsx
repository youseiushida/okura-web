// 設定（共有の範囲・メンバー・AI・エージェント連携・市町村と保険者の値・計算の問い・版・操作の記録）
import { Fragment, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useNavigate, useParams } from 'react-router';
import { get, post, ApiError } from '../lib/api';
import { FieldWidget } from '../lib/forms';
import { enumLabel } from '../lib/labels.js';
import { CLIENTS as CLIENTS_RAW } from '../lib/mcp_clients.js';
import { passkeyAvailable, registerPasskey } from '../lib/passkey.js';
import { refreshStatus } from '../lib/status';
import { useS, loadMeta, loadHousehold, personName, formCtx } from '../lib/store';
import { useApi } from '../lib/useApi';
import { Icon } from '../ui/Icon';
import { Loaded, ErrorNote, Skeleton, ProblemsList, copyText } from '../ui/bits';
import { toast, errorToast, modal, confirmBox } from '../ui/overlay';
import { CategorySettings } from './Book';
import { openInvite } from './Results';
import { settingFieldLabel, settingValueText } from './settingProposal';

const CLIENTS: any[] = CLIENTS_RAW;

const TABS: Array<[string, string]> = [
  ['consents', '共有設定'], ['members', 'メンバー'], ['invites', '依頼'],
  ['categories', 'カテゴリ'],
  ['injections', '市区町村・保険'], ['query', '計算の対象'],
  ['ai', 'AI'], ['agents', 'AI連携'],
  ['login', 'ログイン'],
];

export function SettingsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const tab = params.tab || 'consents';
  const splat = params['*'] || '';
  const rest = splat ? splat.split('/') : [];
  let content;
  switch (tab) {
    case 'members': content = <Members />; break;
    case 'invites': content = <Invites />; break;
    case 'categories': content = <CategorySettings />; break;
    case 'login': content = <LoginSettings />; break;
    case 'ai': content = <Ai />; break;
    case 'agents': content = <Agents />; break;
    // 道の続き（項目・区分・コード）が変わったら、選び直した状態で作り直す
    case 'injections': content = <Injections key={splat} pointArg={rest[0]} issuerKindArg={rest[1]} issuerCodeArg={rest[2]} />; break;
    case 'query': content = <Query />; break;
    default: content = <Consents />;
  }
  return (
    <>
      <div className="page-head"><h1>設定</h1></div>
      <div className="tabs">{TABS.map(([k, l]) => <button type="button" key={k} className={k === tab ? 'on' : ''} onClick={() => navigate(`/settings/${k}`)}>{l}</button>)}</div>
      <div>{content}</div>
    </>
  );
}

// ------------------------------------------------------------------ ログイン（パスキー）
function LoginSettings() {
  const q = useApi('/api/passkeys');
  return (
    <Loaded q={q}>{(r: any) => {
      const can = passkeyAvailable() && r.available;
      const add = async () => {
        const label = navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android' : navigator.userAgent.includes('Mac') ? 'Mac' : 'このパソコン';
        try { await registerPasskey(label); toast('登録しました'); q.reload(); } catch (e: any) { if (e && e.name === 'NotAllowedError') return; errorToast(e); }
      };
      const revoke = async (p: any) => {
        if (!(await confirmBox('外しますか？', 'このパスキーではログインできなくなります', '外す', 'danger'))) return;
        try { await post(`/api/passkeys/${p.id}/revoke`, {}); q.reload(); } catch (e) { errorToast(e); }
      };
      return (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}><h3 style={{ margin: 0 }}><Icon name="key" size={16} /> パスキー</h3>
            {can ? <button type="button" className="btn primary" onClick={add}><Icon name="plus" size={15} />追加</button> : null}</div>
          {!can ? <p className="muted" style={{ marginBottom: 0 }}>公開のアドレス（https）で開くと追加できます</p> : null}
          {r.passkeys.length ? (
            <div className="stack" style={{ marginTop: '12px' }}>{r.passkeys.map((p: any) => (
              <div className="row" style={{ justifyContent: 'space-between' }} key={p.id}>
                <div><b>{p.label}</b><div className="muted" style={{ fontSize: '12px' }}>{`追加 ${p.created_at.slice(0, 10)}${p.last_used_at ? `・最後に使った日 ${p.last_used_at.slice(0, 10)}` : ''}`}</div></div>
                <button type="button" className="btn small" onClick={() => revoke(p)}>外す</button>
              </div>
            ))}</div>
          ) : null}
        </div>
      );
    }}</Loaded>
  );
}

// ------------------------------------------------------------------ 依頼（招待リンク）
const INVITE_STATE: Record<string, [string, string]> = { pending: ['未使用', ''], claimed: ['開いた', 'ok'], expired: ['期限切れ', 'oos'], revoked: ['取消し', 'oos'] };

function Invites() {
  const q = useApi('/api/invites');
  const persons = useS((s) => s.persons);
  const me = useS((s) => s.me);
  useEffect(() => { loadHousehold().catch(errorToast); }, []);
  const askable = persons.filter((p) => !p.has_account && (p.is_mine || me.role === 'admin'));
  const fmt = (t: string) => (t ? t.slice(0, 16).replace('T', ' ') : '');
  const revoke = async (x: any) => {
    if (!(await confirmBox('取り消しますか？', x.status === 'claimed' ? 'この端末からは答えられなくなります' : 'このリンクは使えなくなります', '取り消す', 'danger'))) return;
    try { await post(`/api/invites/${x.id}/revoke`); toast('取り消しました'); q.reload(); } catch (e) { errorToast(e); }
  };
  return (
    <Loaded q={q}>{(r: any) => (
      <>
        <div className="row" style={{ gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {askable.map((p) => <button type="button" className="btn" key={p.person_id} onClick={async () => { await openInvite(p.person_id, null); q.reload(); }}><Icon name="send" size={14} />{`${p.display_name}さんに聞く`}</button>)}</div>
        {r.invites.length ? (
          <div className="stack">{r.invites.map((x: any) => {
            const [label, chip] = INVITE_STATE[x.status] || [x.status, ''];
            return (
              <div className="card" key={x.id}>
                <div className="row" style={{ justifyContent: 'space-between', gap: '8px' }}>
                  <b>{`${x.person || ''}さん`}</b><span className={`chip ${chip}`}>{label}</span></div>
                <div className="muted" style={{ fontSize: '13px', marginTop: '6px' }}>
                  <div>{`${fmt(x.created_at)} に${x.created_by || ''}さんが作成・期限 ${x.expires_at.slice(0, 10)}`}</div>
                  {x.email ? <div>{`確認するメール：${x.email}`}</div> : null}
                  {x.claimed_at ? <div>{`${fmt(x.claimed_at)} に開いた${x.claimed_email ? `（${x.claimed_email} で確認）` : ''}`}</div> : null}
                  {x.answers ? <div>{`回答 ${x.answers}件`}</div> : null}</div>
                {x.status === 'pending' || x.status === 'claimed' ? (
                  <div className="row end" style={{ marginTop: '8px' }}>
                    <button type="button" className="btn small" onClick={() => revoke(x)}>取り消す</button></div>
                ) : null}
              </div>
            );
          })}</div>
        ) : <div className="card empty"><Icon name="send" size={28} /><b>まだ依頼はありません</b></div>}
      </>
    )}</Loaded>
  );
}

// ------------------------------------------------------------------ 同意
const CONSENT_LABEL: Record<string, string> = { share_numbers: '金額', share_details: '明細', share_originals: '書類の画像', external_ai: '外部の AI' };

function Consents() {
  const q = useApi('/api/consents');
  const persons = useS((s) => s.persons);
  // 押した直後のスイッチの向き（サーバーの値が取り直されるまで。失敗したら元の向きに戻す）
  const [over, setOver] = useState<Record<string, boolean>>({});
  const pending = useRef(0);
  useEffect(() => { loadHousehold().catch(errorToast); }, []);
  // 取り直した値が来たら、サーバーの値をそのまま出す（送っている途中の分は残す）
  useEffect(() => { if (!pending.current) setOver({}); }, [q.data]);
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <Skeleton />;
  const c: any = q.data;
  const mine = persons.filter((p) => c.can_decide.includes(p.person_id));
  const change = async (pid: string, k: string, before: boolean, value: boolean) => {
    const key = `${pid}|${k}`;
    setOver((o) => ({ ...o, [key]: value }));
    pending.current += 1;
    try { await post('/api/consents', { person_id: pid, kind: k, value }); toast(value ? '共有します' : '共有しません'); }
    catch (e) { setOver((o) => ({ ...o, [key]: before })); errorToast(e); }
    finally { pending.current -= 1; }
  };
  return (
    <>
      <div className="note">家族のほかの人に見せる情報を選びます</div>
      <div className="grid c2" style={{ marginTop: '12px' }}>{mine.length ? mine.map((p) => (
        <div className="card" key={p.person_id}>
          <h3>{p.display_name}</h3>
          {Object.entries(c.kinds).map(([k, text]) => {
            const key = `${p.person_id}|${k}`;
            const cur = c.current[key];
            const checked = key in over ? over[key] : (cur ? !!cur.value : false);
            return (
              <div className="toggle" key={k}><label className="switch"><input type="checkbox" checked={checked} onChange={(e) => change(p.person_id, k, checked, e.target.checked)} /><span /></label>
                <div className="tg-body"><b>{CONSENT_LABEL[k] || '共有'}</b><div className="muted">{text as string}</div>
                  <div className="muted" style={{ fontSize: '.78rem' }}>{cur ? cur.decided_at.slice(0, 16).replace('T', ' ') : '未設定'}</div></div></div>
            );
          })}
        </div>
      )) : <div className="empty">設定できる人がいません</div>}</div>
      <h2>変更履歴</h2>
      {/* 1行ずつの並び（表だとスマホで列がつぶれる）：だれの・何を・どうしたか、いつ・だれが変えたか */}
      <div className="card flush hist-list">{c.history.length ? c.history.map((x: any, i: number) => (
        <div className="hist-row" key={i}>
          <div><b>{x.person || '—'}</b>{` の ${CONSENT_LABEL[x.kind] || '共有'}`}<span className={`chip ${x.value ? 'ok' : ''}`} style={{ marginLeft: '8px' }}>{x.value ? '共有する' : 'しない'}</span></div>
          <div className="muted">{`${String(x.decided_at).slice(0, 16).replace('T', ' ')}・変更した人 ${x.decided_by}`}</div>
        </div>
      )) : <div className="empty">まだ変更はありません</div>}</div>
    </>
  );
}

// ------------------------------------------------------------------ メンバー
function Members() {
  const q = useApi('/api/members');
  const me = useS((s) => s.me);
  useS((s) => s.persons); // 人の名前（personName）が変わったら描き直す
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const isAdmin = me.role === 'admin';
  const change = async () => {
    try { await post('/api/me/password', { current: cur, new: nw }); toast('変更しました'); setTimeout(() => location.reload(), 800); } catch (e) { errorToast(e); }
  };
  return (
    <Loaded q={q}>{(r: any) => (
      <>
        <div className="table-wrap"><table className="t"><thead><tr><th>表示名</th><th>ログイン名</th><th>役割</th><th>人</th></tr></thead>
          <tbody>{r.members.map((m: any, i: number) => <tr key={i}><td>{m.display_name}</td><td>{m.login || '—'}</td><td>{m.role === 'admin' ? '管理者' : 'メンバー'}</td><td>{personName(m.person_id)}</td></tr>)}</tbody></table></div>
        {isAdmin ? <p className="muted">招待は「家族」から</p> : null}
        <h2>パスワードの変更</h2>
        <div className="card form" style={{ maxWidth: '420px' }}>
          <div className="field"><label>現在のパスワード</label><input type="password" className="in" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
          <div className="field"><label>新しいパスワード（10文字以上）</label><input type="password" className="in" value={nw} onChange={(e) => setNw(e.target.value)} /></div>
          <button type="button" className="btn primary" onClick={change}>変更</button></div>
      </>
    )}</Loaded>
  );
}

// ------------------------------------------------------------------ AI
function Ai() {
  const q = useApi('/api/settings/llm');
  return <Loaded q={q}>{(c: any) => <AiForm c={c} />}</Loaded>;
}

function AiForm({ c }: { c: any }) {
  const me = useS((s) => s.me);
  const isAdmin = me.role === 'admin';
  const [base, setBase] = useState<string>(c.base_url ?? '');
  const [model, setModel] = useState<string>(c.model || '');
  const [vision, setVision] = useState<string>(c.vision_model || '');
  const [key, setKey] = useState('');
  // この PC の中継（cliproxy など）でも、その先が Claude・ChatGPT などなら外部
  const [forwards, setForwards] = useState<boolean>(!!c.forwards_external);
  const [status, setStatus] = useState<null | 'wait' | { ok: boolean; text: string }>(null);
  const isLocalUrl = () => { try { const u = new URL(base); return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname); } catch { return false; } };
  const isExternal = () => !isLocalUrl() || forwards;
  const save = async () => {
    const body: any = { base_url: base, model, vision_model: vision || null, forwards_external: forwards };
    if (key) body.api_key = key;
    if (isExternal()) {
      const ok = await modal('外部の AI を使いますか？', <div><p>{`送り先：${base}`}</p><p>会話と計算結果を送信します。名前・住所などは伏せます</p><p className="muted" /></div>, [{ label: 'キャンセル', value: false }, { label: '使う', value: true, kind: 'primary' }]);
      if (!ok) return;
      body.confirm_external = true;
    }
    try { await post('/api/settings/llm', body); toast('保存しました'); } catch (e) { errorToast(e); }
  };
  const test = async () => {
    setStatus('wait');
    try { const r = await post('/api/llm/test', {}); setStatus(r.ok ? { ok: true, text: `接続できました：${(r.models || []).join('、') || '—'}` } : { ok: false, text: r.message }); }
    catch (e: any) { setStatus({ ok: false, text: e.message }); }
  };
  return (
    <div className="card form" style={{ maxWidth: '640px' }}>
      <p className="muted">OpenAI 互換の API（Ollama・LM Studio など）</p>
      <div className="field"><label>base_url</label><input type="url" className="in" value={base} onChange={(e) => setBase(e.target.value)} /></div>
      <label className="check-line"><input type="checkbox" checked={forwards} onChange={(e) => setForwards(e.target.checked)} /> この先で外部のサービス（Claude・ChatGPT など）につながる</label>
      <div>{isExternal() ? <div className="note bad"><b>外部のサービスに送信されます</b>名前などは伏せて送信します</div> : <div className="note ok">このパソコンの AI です。外部に送信しません</div>}</div>
      <div className="field"><label>モデル</label><input type="text" className="in" value={model} placeholder="例：qwen2.5:14b（ollama list の名前）"
        onChange={(e) => { setModel(e.target.value); if (/^(claude|gpt|gemini|o\d)/i.test(e.target.value) && isLocalUrl()) setForwards(true); }} /></div>
      <div className="field"><label>画像読み取りのモデル（任意）</label><input type="text" className="in" value={vision} placeholder="画像を読めるモデル（例：qwen2.5vl:7b）" onChange={(e) => setVision(e.target.value)} /></div>
      <div className="field"><label>API キー</label><input type="password" className="in" value={key} placeholder={c.has_api_key ? '設定済み' : '不要な場合は空欄'} onChange={(e) => setKey(e.target.value)} /></div>
      {isAdmin ? (
        <div className="row">
          <button type="button" className="btn primary" onClick={save}>保存</button>
          <button type="button" className="btn" onClick={test}>接続テスト</button></div>
      ) : <p className="muted">管理者のみ変更できます</p>}
      <div>{status === 'wait' ? <span className="spinner" /> : status ? <div className={`note ${status.ok ? 'ok' : 'bad'}`}>{status.text}</div> : null}</div>
    </div>
  );
}

// ------------------------------------------------------------------ エージェント連携
let issuedToken: string | null = null; // 発行した直後のトークン（この画面を開いている間だけ。保存しない）
let selectedClient: string | null = null;

function ClientIcon({ c, size = 28 }: { c: any; size?: number }) {
  if (!c.icon) return <span className="ci-fallback">{c.name.slice(0, 1)}</span>;
  return (
    <svg viewBox={c.icon.viewBox} width={size} height={size} aria-hidden="true">
      {c.icon.paths.map((p: any, i: number) => <path key={i} d={p.d} fill={p.fill || 'currentColor'} fillRule={p['fill-rule'] || undefined} />)}
    </svg>
  );
}

// このパソコンの置き場所（サーバーが教える。/api/tokens を読んだときに入れる）
let localMcp = { python: '<python の場所>', script: '<okura-web の場所>/mcp_server.py' };

function fill(text: string, url: string, token: string | null) {
  return String(text).replaceAll('{URL}', url).replaceAll('{TOKEN}', token || '<アクセストークン>')
    .replaceAll('{PYTHON}', localMcp.python).replaceAll('{MCP_SERVER}', localMcp.script);
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="copy-line"><span className="cl-label">{label}</span><code className="cl-value">{value}</code>
      <button type="button" className="btn small icon ghost" title="コピー" aria-label={`${label}をコピー`} onClick={() => copyText(value)}><Icon name="copy" size={15} /></button></div>
  );
}

type TokenChoice = { label: string; propose: boolean; useImport: boolean };

/** アクセストークンの発行のダイアログの中身。選んだ値は out に書く（発行のボタンが読む） */
function TokenDialog({ scope, out }: { scope: any; out: TokenChoice }) {
  const [v, setV] = useState<TokenChoice>({ ...out });
  const set = (patch: Partial<TokenChoice>) => { const n = { ...v, ...patch }; Object.assign(out, n); setV(n); };
  const use = (useImport: boolean) => {
    let label = v.label;
    if (useImport && label === 'AI') label = '取り込み';
    if (!useImport && label === '取り込み') label = 'AI';
    set({ useImport, label });
  };
  return (
    <div className="form">
      <div className="checks"><label><input type="radio" name="tok-use" checked={!v.useImport} onChange={() => use(false)} /> AI エージェント</label><label><input type="radio" name="tok-use" checked={v.useImport} onChange={() => use(true)} /> 家計簿の取り込み</label></div>
      <div className="field"><label>名前</label><input type="text" className="in" value={v.label} onChange={(e) => set({ label: e.target.value })} /></div>
      <div className="stack" style={{ display: v.useImport ? 'none' : undefined }}>
        <label><input type="checkbox" checked={v.propose} onChange={(e) => set({ propose: e.target.checked })} /> 提案を許可（登録はあなたが行います）</label>
        <div className="note warn"><Icon name="lock" size={16} /><div>外部の AI に送信されます。名前・住所などは伏せます。
          <br />対象：{scope.persons_sent.map((p: any) => p.name).join('、') || 'なし（共有設定で「外部の AI」をオンにした人だけ）'}</div></div>
      </div>
      <div className="note" style={{ display: v.useImport ? undefined : 'none' }}><Icon name="inbox" size={16} /><div>家計簿の取り込み待ちに置くだけ。家計簿や計算の結果は読めません。</div></div>
    </div>
  );
}

function Agents() {
  const q = useApi('/api/tokens');
  if (q.data && q.data.local_mcp) localMcp = q.data.local_mcp;
  const [token, setToken] = useState<string | null>(issuedToken);
  const [sel, setSel] = useState<string | null>(() => {
    if (!selectedClient) selectedClient = CLIENTS[0] && CLIENTS[0].id;
    return selectedClient;
  });
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(0); // 接続先を選ぶたびに、手順が見える所までスクロールする
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (picked) detail.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [picked]);

  const issue = async () => {
    let scope: any;
    try { scope = await get('/api/agent/scope'); } catch (e) { errorToast(e); return; }
    const out: TokenChoice = { label: 'AI', propose: true, useImport: false };
    const ok = await modal('アクセストークンを発行', <TokenDialog scope={scope} out={out} />,
      [{ label: 'キャンセル', value: false }, { label: '発行', value: true, kind: 'primary' }]);
    if (!ok) return;
    try {
      const body = out.useImport ? { label: out.label || '取り込み', scopes: ['import'], external: false }
        : { label: out.label || 'AI', scopes: out.propose ? ['read', 'propose'] : ['read'], external: true, acknowledge_external: true };
      const t = await post('/api/tokens', body);
      issuedToken = t.token;
      setToken(t.token);
      toast('発行しました。この画面を閉じると、もう表示されません');
      q.reload();
    } catch (e) { errorToast(e); }
  };
  const revoke = async (t: any) => {
    try { await post(`/api/tokens/${t.id}/revoke`, {}); toast('無効にしました'); q.reload(); } catch (e) { errorToast(e); }
  };

  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <Skeleton />;
  const r: any = q.data;
  const mcpUrl = `${location.origin}/mcp`;
  const active = r.tokens.filter((t: any) => !t.revoked_at);
  const c = CLIENTS.find((x) => x.id === sel);
  const url = c && (c.headers ? mcpUrl : `${mcpUrl}?token=${token || '<アクセストークン>'}`);
  const s = search.trim().toLowerCase();
  return (
    <>
      <div className="section-title">サーバー URL</div>
      <div className="url-box"><span className="live-dot" /><code>{mcpUrl}</code><button type="button" className="btn small icon ghost" title="コピー" onClick={() => copyText(mcpUrl)}><Icon name="copy" size={15} /></button></div>
      <div className="section-title">アクセストークン</div>
      {token ? <div className="url-box"><Icon name="key" size={15} /><code>{token}</code><button type="button" className="btn small icon ghost" title="コピー" onClick={() => copyText(token)}><Icon name="copy" size={15} /></button></div>
        : <div className="row"><button type="button" className="btn primary" onClick={issue}><Icon name="key" size={15} />アクセストークンを発行</button><span className="muted" style={{ fontSize: '12.5px' }}>{active.length ? `発行済み ${active.length}件` : ''}</span></div>}
      <h2>接続</h2>
      <input type="search" className="in" placeholder="検索" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="client-grid">{CLIENTS.filter((x) => !s || x.name.toLowerCase().includes(s)).map((x) => (
        <button type="button" key={x.id} className={`client ${sel === x.id ? 'on' : ''}`} onClick={() => { selectedClient = x.id; setSel(x.id); setPicked((n) => n + 1); }}>
          <span className="ci"><ClientIcon c={x} /></span><span>{x.name}</span></button>
      ))}</div>
      <div ref={detail}>{c ? (
        <div className="card client-detail">
          <div className="row" style={{ gap: '12px', marginBottom: '14px' }}><span className="ci big"><ClientIcon c={c} size={30} /></span><h2 style={{ margin: 0 }}>{c.name}</h2></div>
          {!token ? <div className="note warn" style={{ marginBottom: '14px' }}><Icon name="key" size={16} /><div style={{ flex: 1 }}>アクセストークンを発行すると、下の値に入ります</div><button type="button" className="btn small" onClick={issue}>発行</button></div> : null}
          <div className="section-title">手順</div>
          <ol className="steps-list">{c.steps.map((st: string, i: number) => <li key={i}>{fill(st, url, token)}</li>)}</ol>
          {c.fields && c.fields.length ? <><div className="section-title">入力</div>{c.fields.map((f: any, i: number) => <CopyRow key={i} label={f.label} value={fill(f.value, url, token)} />)}</> : null}
          {c.snippet ? <><div className="section-title">{c.snippet.file || 'コマンド'}</div>
            <div className="snippet"><pre>{fill(c.snippet.text, url, token)}</pre><button type="button" className="btn small" onClick={() => copyText(fill(c.snippet.text, url, token))}><Icon name="copy" size={14} />コピー</button></div></> : null}
          {!c.headers ? <p className="muted" style={{ fontSize: '12.5px' }}>このアプリはヘッダーを送れないため、URL にトークンを入れています。URL は人に見せないでください</p> : null}
          {c.docs ? <a className="btn small ghost" href={c.docs} target="_blank" rel="noopener noreferrer">公式の手順<Icon name="external" size={13} /></a> : null}
        </div>
      ) : null}</div>
      {active.length ? <><h2>発行済みのアクセストークン</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>名前</th><th>権限</th><th className="hide-sm">発行日</th><th className="hide-sm">最終利用</th><th /></tr></thead>
          <tbody>{active.map((t: any) => (
            <tr key={t.id}><td>{t.label}</td><td>{t.scopes.includes('import') ? '取り込み' : t.scopes.includes('propose') ? '読む・提案' : '読む'}</td><td className="hide-sm">{t.created_at.slice(0, 10)}</td><td className="hide-sm">{(t.last_used_at || '—').slice(0, 16).replace('T', ' ')}</td>
              <td><button type="button" className="btn small danger" onClick={() => revoke(t)}>無効化</button></td></tr>
          ))}</tbody></table></div></> : null}
    </>
  );
}

// ------------------------------------------------------------------ 注入データ
// 注入点の欄（DataField）を入力欄のスキーマに直す
function dfSchema(f: any): any {
  switch (f.kind) {
    case 'yen': return { $ref: '#/$defs/yen' };
    case 'ratio': return { $ref: '#/$defs/ratio' };
    case 'count': return { type: 'integer' };
    case 'bool': return { type: 'boolean' };
    case 'enum': return { type: 'string', enum: f.values };
    case 'names': return { type: 'array', items: { type: 'string' } };
    case 'object': return { type: 'object', properties: Object.fromEntries(f.fields.map((x: any) => [x.name, dfSchema(x)])), required: f.fields.filter((x: any) => x.required).map((x: any) => x.name) };
    case 'objects': return { type: 'array', items: dfSchema({ ...f, kind: 'object' }) };
    default: return { type: 'string' };
  }
}

type Reader = { read(): any };

/** 注入点の欄（yen・ratio・count・bool・enum・names・object・objects）。値は ref の read() で読む（なければ undefined、形が違えば例外） */
function DataField({ f, init, ref }: { f: any; init?: any; ref?: Ref<Reader> }) {
  const [text, setText] = useState<string>(() => {
    if (f.kind === 'yen' || f.kind === 'count') return String(init ?? '');
    if (f.kind === 'ratio') return init ? `${init.num}/${init.den}` : '';
    if (f.kind === 'enum') return f.values.includes(init) ? init : '';
    return '';
  });
  const w = useRef<Reader>(null);
  useImperativeHandle(ref, () => ({
    read() {
      if (f.kind === 'yen' || f.kind === 'count') {
        const s = text.replace(/[,，\s円]/g, '');
        if (!s) return undefined;
        if (!/^\d+$/.test(s)) throw new Error(`${f.name} は 0 以上の整数`);
        return +s;
      }
      if (f.kind === 'ratio') {
        const s = text.trim();
        if (!s) return undefined;
        let m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (m) return { num: +m[1], den: +m[2] };
        m = s.match(/^(\d+(?:\.\d+)?)%$/);
        if (m) { const dp = (m[1].split('.')[1] || '').length; return { num: Math.round(parseFloat(m[1]) * 10 ** dp), den: 100 * 10 ** dp }; }
        throw new Error(`${f.name} は 6/100 か 6% の形`);
      }
      if (f.kind === 'bool') return text === '' ? undefined : text === 'true';
      if (f.kind === 'enum') return text || undefined;
      if (f.kind === 'names') { const v = text.split(/[、,]/).map((x) => x.trim()).filter(Boolean); return v.length ? v : undefined; }
      return w.current!.read();
    },
  }));
  let input;
  if (f.kind === 'yen' || f.kind === 'count') input = <input type="text" className="in yen-input" value={text} onChange={(e) => setText(e.target.value)} />;
  else if (f.kind === 'ratio') input = <input type="text" className="in" placeholder="6/100 か 6%" value={text} onChange={(e) => setText(e.target.value)} />;
  else if (f.kind === 'bool') input = <select className="in" value={text} onChange={(e) => setText(e.target.value)}><option value="">（選ぶ）</option><option value="true">はい</option><option value="false">いいえ</option></select>;
  else if (f.kind === 'enum') input = <select className="in" value={text} onChange={(e) => setText(e.target.value)}><option value="">（選ぶ）</option>{f.values.map((v: string) => <option key={v} value={v}>{v}</option>)}</select>;
  else if (f.kind === 'names') input = <input type="text" className="in" placeholder="、で区切る" value={text} onChange={(e) => setText(e.target.value)} />;
  else input = <FieldWidget ref={w} schema={dfSchema(f)} initial={init} ctx={formCtx()} />;
  return (
    <div className="field">
      <label>{f.title || f.name}{f.required ? <span className="req">*</span> : null}<span className="muted mono" style={{ marginLeft: '6px', fontWeight: 400 }}>{f.name}</span></label>
      {input}
    </div>
  );
}

function InjectionForm({ p, meta, isAdmin, issuerKindArg, issuerCodeArg, onSaved }: { p: any; meta: any; isAdmin: boolean; issuerKindArg?: string; issuerCodeArg?: string; onSaved: () => void }) {
  const [ik, setIk] = useState<string>(() => (p.issuer_kinds.includes(issuerKindArg) ? issuerKindArg : p.issuer_kinds[0]) ?? '');
  const [code, setCode] = useState(issuerCodeArg || '');
  // 市区町村・都道府県は、コードを打たずに総務省の一覧から選ぶ（打ち間違い・区のコードを防ぐ。サーバーも一覧で確かめる）
  const muni = useRef<Reader | null>(null);
  const [prefs, setPrefs] = useState<string[][]>([]);
  useEffect(() => { import('../lib/municipalities.js').then((m) => setPrefs((m.PREFECTURES || []) as string[][])); }, []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [url, setUrl] = useState('');
  const [got, setGot] = useState(() => new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<string>(() => (meta.source_kinds.includes('自治体の資料') ? '自治体の資料' : meta.source_kinds[0]) ?? '');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<{ message: string; detail: any } | null>(null);
  const fields = useRef<Array<Reader | null>>([]);
  const save = async () => {
    const data: Record<string, any> = {};
    let issuerCode = code.trim();
    if (ik === 'municipality') {
      try { issuerCode = muni.current ? (muni.current.read() || '') : ''; } catch (e: any) { toast(`市区町村：${e.message}`, 'bad'); return; }
    }
    if (!issuerCode) { toast(ik === 'municipality' ? '市区町村を選んでください' : ik === 'prefecture' ? '都道府県を選んでください' : '番号を入れてください', 'bad'); return; }
    try { p.fields.forEach((f: any, i: number) => { const v = fields.current[i]!.read(); if (v !== undefined) data[f.name] = v; }); } catch (e: any) { toast(e.message, 'bad'); return; }
    try {
      await post('/api/injections', { point: p.name, issuer: { kind: ik, code: issuerCode }, applies: { from_on: from, ...(to ? { to_on: to } : {}) }, source: { url, retrieved_on: got, source_kind: kind, ...(title ? { title } : {}) }, data });
      toast('保存しました');
      await refreshStatus();
      onSaved();
    } catch (e) { errorToast(e); if (e instanceof ApiError) setErr({ message: e.message, detail: e.detail }); }
  };
  return (
    <div className="card stack">
      <h3>{p.title}</h3><div className="muted" />
      {p.candidates.length ? <div className="note">{`未設定のときは ${p.candidates.map((c: any) => c.label).join('・')} のすべてで計算します`}</div> : <div className="note warn">設定するまで、関係する金額は未確定になります</div>}
      {p.note ? <div className="muted">{p.note}</div> : null}
      <div className="form-cols"><div className="field"><label>区分</label><select className="in" value={ik} onChange={(e) => { setIk(e.target.value); setCode(''); }}>{p.issuer_kinds.map((k: string) => <option key={k} value={k}>{enumLabel(k)}</option>)}</select></div>
        {ik === 'municipality' ? (
          <div className="field"><label>市区町村</label>
            <FieldWidget key="muni" ref={muni} schema={{ $ref: '#/$defs/municipality_code' }} initial={issuerKindArg === 'municipality' ? issuerCodeArg : undefined} ctx={formCtx()} /></div>
        ) : ik === 'prefecture' ? (
          <div className="field"><label>都道府県</label>
            <select className="in" value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">（選ぶ）</option>
              {prefs.map((r) => <option key={r[0]} value={r[0]}>{r[1]}</option>)}
            </select></div>
        ) : (
          <div className="field"><label>保険者番号</label><input type="text" className="in" placeholder="保険証に書いてある番号" value={code} onChange={(e) => setCode(e.target.value)} /></div>
        )}
        <div className="field"><label>開始日</label><input type="date" className="in" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>終了日（任意）</label><input type="date" className="in" value={to} onChange={(e) => setTo(e.target.value)} /></div></div>
      <h3>値</h3><div className="form-cols">{p.fields.map((f: any, i: number) => <DataField key={f.name} f={f} ref={(r) => { fields.current[i] = r; }} />)}</div>
      <h3>出典</h3>
      <div className="form-cols"><div className="field"><label>URL</label><input type="url" className="in" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div className="field"><label>取得日</label><input type="date" className="in" value={got} onChange={(e) => setGot(e.target.value)} /></div>
        <div className="field"><label>資料の種類</label><select className="in" value={kind} onChange={(e) => setKind(e.target.value)}>{meta.source_kinds.map((k: string) => <option key={k} value={k}>{k}</option>)}</select></div>
        <div className="field"><label>資料名</label><input type="text" className="in" placeholder="資料名（任意）" value={title} onChange={(e) => setTitle(e.target.value)} /></div></div>
      <div>{err ? <div className="note bad">{err.message}<ProblemsList detail={err.detail} /></div> : null}</div>
      {isAdmin ? <button type="button" className="btn primary" onClick={save}>保存</button> : <p className="muted">管理者のみ設定できます</p>}
    </div>
  );
}

function Injections({ pointArg, issuerKindArg, issuerCodeArg }: { pointArg?: string; issuerKindArg?: string; issuerCodeArg?: string }) {
  const q = useApi('/api/injections');
  const meta = useS((s) => s.meta);
  const me = useS((s) => s.me);
  const [metaError, setMetaError] = useState<any>(null);
  // 選んだ項目（null：まだ選んでいない＝道で指定された項目）。saved：保存のたびに入力欄を作り直す
  const [chosen, setChosen] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  useEffect(() => { loadMeta().catch(setMetaError); }, []);
  if (!q.data || !meta) return q.error || metaError ? <ErrorNote error={q.error || metaError} /> : <Skeleton />;
  const r: any = q.data;
  const isAdmin = me.role === 'admin';
  const points: any[] = meta.injection_points;
  const sel = chosen !== null ? chosen : (points.some((x) => x.name === pointArg) ? pointArg! : '');
  const p = points.find((x) => x.name === sel);
  const retire = async (x: any) => {
    try { await post(`/api/injections/${x.id}/retire`, {}); toast('解除しました'); q.reload(); } catch (e) { errorToast(e); }
  };
  return (
    <>
      <div className="note">お住まいの市区町村や加入している保険で変わる値を、出典つきで設定します</div>
      <h2>設定済み</h2>
      {/* 1件ずつのカード（表だとスマホで列がつぶれる） */}
      <div className="stack">{r.injections.length ? r.injections.map((x: any) => {
        const e = x.entry;
        const pt = points.find((y) => y.name === e.point);
        const [inst, short] = String(e.point).includes('.') ? [String(e.point).split('.')[0], String(e.point).split('.').slice(1).join('.')] : ['', String(e.point)];
        const fieldOf: Record<string, any> = Object.fromEntries(((pt && pt.fields) || []).map((f: any) => [f.name, f]));
        const safe = typeof e.source.url === 'string' && /^https?:\/\//i.test(e.source.url);
        return (
          <div className="card inj-card" key={x.id} style={x.retired_at ? { opacity: 0.55 } : undefined}>
            <div className="row between" style={{ gap: '8px', alignItems: 'flex-start' }}>
              <div><b>{short}</b>{inst ? <span className="chip" style={{ marginLeft: '6px' }}>{inst}</span> : null}</div>
              {x.retired_at ? <span className="chip">解除済み</span> : isAdmin ? <button type="button" className="btn small danger" onClick={() => retire(x)}>解除</button> : null}
            </div>
            <dl className="inj-kv">
              <dt>市区町村・保険者</dt><dd>{x.issuer_label || `${enumLabel(e.issuer.kind)} ${e.issuer.code}`}</dd>
              <dt>適用</dt><dd>{`${e.applies.from_on}〜${e.applies.to_on || ''}`}</dd>
              {Object.entries(e.data || {}).map(([k, v]) => <Fragment key={k}><dt>{settingFieldLabel(fieldOf[k], k)}</dt><dd>{settingValueText(v, fieldOf[k] && fieldOf[k].kind)}</dd></Fragment>)}
              <dt>出典</dt><dd>{safe ? <a href={e.source.url} target="_blank" rel="noopener noreferrer">{e.source.title || e.source.url}</a> : (e.source.title || '')}
                <div className="muted" style={{ fontSize: '12px' }}>{`${e.source.source_kind}・取得 ${e.source.retrieved_on}`}</div></dd>
            </dl>
          </div>
        );
      }) : <div className="card empty">ありません</div>}</div>
      <h2>追加</h2>
      <select className="in" value={sel} onChange={(e) => setChosen(e.target.value)}><option value="">項目を選択</option>
        {[...new Set(points.map((x) => x.institution))].map((inst) => <optgroup key={inst} label={inst}>{points.filter((x) => x.institution === inst).map((x) => <option key={x.name} value={x.name}>{`${x.name}`}</option>)}</optgroup>)}</select>
      <div>{p ? <InjectionForm key={`${p.name}|${saved}`} p={p} meta={meta} isAdmin={isAdmin} issuerKindArg={issuerKindArg} issuerCodeArg={issuerCodeArg}
        onSaved={() => { setChosen(''); setSaved((n) => n + 1); }} /> : null}</div>
    </>
  );
}

// ------------------------------------------------------------------ 計算の範囲
function Query() {
  const q = useApi('/api/query/default');
  return <Loaded q={q}>{(r: any) => <QueryForm r={r} />}</Loaded>;
}

const clone = (x: any) => JSON.parse(JSON.stringify(x));

function QueryForm({ r }: { r: any }) {
  const me = useS((s) => s.me);
  const [q, setQ] = useState<any>(() => clone(r.query));
  const [newDate, setNewDate] = useState('');
  const toggleYear = (key: string, y: number, on: boolean) => setQ((prev: any) => {
    const set = new Set<number>(prev[key] || []);
    if (on) set.add(y); else set.delete(y);
    const v = [...set].sort();
    return key === 'resident_tax_fiscal_years' ? { ...prev, resident_tax_fiscal_years: v, kokuho_fiscal_years: v, kokunen_fiscal_years: v } : { ...prev, [key]: v };
  });
  const yearChecks = (key: string, years: Array<[number, boolean]>, label: string) => (
    <div className="field"><label>{label}</label>
      <div className="checks">{years.map(([y, ok]) => (
        <label key={y} title={ok ? '' : 'まだ計算できません'}><input type="checkbox" checked={(q[key] || []).includes(y)} onChange={(e) => toggleYear(key, y, e.target.checked)} />{`${y}${key === 'income_tax_years' ? '年分' : '年度'}`}{ok ? null : <span className="muted">（対象外）</span>}</label>
      ))}</div></div>
  );
  return (
    <div className="card form" style={{ maxWidth: '640px' }}>
      {yearChecks('income_tax_years', [[2024, false], [2025, true], [2026, true], [2027, false]], '所得税')}
      {yearChecks('resident_tax_fiscal_years', [[2026, true], [2027, true], [2028, false]], '住民税・国保・国民年金')}
      <div className="field"><label>扶養（健康保険）の判定日</label>
        <div className="checks">{(q.dependent_judgment_dates || []).map((d: string) => (
          <label key={d}>{d}
            <button type="button" className="btn small ghost" aria-label={`${d} を外す`} onClick={() => { setQ((prev: any) => ({ ...prev, dependent_judgment_dates: prev.dependent_judgment_dates.filter((x: string) => x !== d) })); setNewDate(''); }}>×</button></label>
        ))}</div>
        <div className="row" style={{ marginTop: '8px' }}><input type="date" className="in" style={{ width: 'auto' }} value={newDate} onChange={(e) => setNewDate(e.target.value)} /><button type="button" className="btn small" onClick={() => {
          if (!newDate) return;
          setQ((prev: any) => ({ ...prev, dependent_judgment_dates: [...new Set([...(prev.dependent_judgment_dates || []), newDate])].sort() }));
          setNewDate('');
        }}>＋ 追加</button></div></div>
      <div className="field"><label>申告書の提出予定日</label><input type="date" className="in" style={{ width: 'auto' }} value={(q.filing_date || {}).on || ''}
        onChange={(e) => { const v = e.target.value; setQ((prev: any) => ({ ...prev, filing_date: v ? { on: v, planned: true } : null })); }} /></div>
      <div className="row">
        {me.role === 'admin' ? <button type="button" className="btn primary" onClick={async () => { try { await post('/api/query/default', { query: q }); toast('保存しました'); } catch (e) { errorToast(e); } }}>保存</button> : null}
        <button type="button" className="btn" onClick={async () => { try { await post('/api/calc', { query: q }); toast('再計算しています'); await refreshStatus(); } catch (e) { errorToast(e); } }}>この条件で再計算</button>
        <button type="button" className="btn ghost" onClick={() => { setQ(clone(r.builtin)); setNewDate(''); }}>元に戻す</button></div>
    </div>
  );
}

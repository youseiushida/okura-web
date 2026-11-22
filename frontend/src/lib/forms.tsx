// 記録・判断の入力フォーム（中間表現の語彙から作る）。
// AI が読んだ欄は「AI・未確認」の印を付け、人が「確かめた」に印を付けるまで確定できない（⑫）。
import { useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent, type JSX, type Ref } from 'react';
import { yen } from './format';
import { fieldLabel, enumLabel } from './labels.js';

type Quick = { id: string; icon: string; name: string; sub?: string; kind: string; main: string[]; roleDefault?: string; sync?: Array<[string, string]>; defaults?: any };

// よく使う入力（ぺたっと貼ったときに選ぶ書類の種類）
export const QUICK: Quick[] = [
  { id: 'salary', icon: 'wallet', name: '給与明細', sub: 'バイト代も', kind: 'salary_payment',
    main: ['roles.recipient', 'attributes.counterparty', 'attributes.due_on', 'amounts.gross', 'amounts.withholding_tax', 'amounts.social_insurance_withheld', 'amounts.commuting_allowance', 'when.on'],
    roleDefault: 'recipient', sync: [['attributes.due_on', 'when.on']] },
  { id: 'slip', icon: 'file', name: '源泉徴収票', sub: '', kind: 'withholding_slip',
    main: ['roles.recipient', 'when.tax_year', 'attributes.slip_type', 'attributes.counterparty', 'amounts.payment_amount', 'amounts.withholding_tax', 'amounts.social_insurance'],
    roleDefault: 'recipient', defaults: { attributes: { slip_type: 'salary' } } },
  { id: 'medical', icon: 'heart', name: '医療費', sub: '病院・薬局', kind: 'medical_payment',
    main: ['roles.payer', 'roles.patient', 'attributes.incurred_on', 'attributes.provider', 'amounts.amount', 'attributes.medical_kinds', 'when.on'],
    roleDefault: 'payer', defaults: { attributes: { medical_kinds: ['medical_treatment'] } }, sync: [['attributes.incurred_on', 'when.on']] },
  { id: 'expense', icon: 'receipt', name: '経費', sub: '副業・事業', kind: 'business_expense',
    main: ['roles.payer', 'when.on', 'attributes.business_id', 'attributes.expense_category', 'attributes.counterparty', 'amounts.amount'], roleDefault: 'payer' },
  { id: 'sales', icon: 'briefcase', name: '売上', sub: '副業・事業', kind: 'business_receipt',
    main: ['roles.recipient', 'when.on', 'attributes.business_id', 'attributes.counterparty', 'amounts.amount', 'amounts.withholding_tax'], roleDefault: 'recipient' },
  { id: 'social', icon: 'shield', name: '社会保険料', sub: '国民年金・国保', kind: 'social_insurance_payment',
    main: ['roles.payer', 'roles.liable_person', 'when.on', 'attributes.premium_type', 'amounts.amount'], roleDefault: 'payer' },
  { id: 'donation', icon: 'gift', name: 'ふるさと納税', sub: '寄附金', kind: 'donation',
    main: ['roles.donor', 'when.on', 'attributes.recipient_name', 'attributes.recipient_local_government_kind', 'amounts.amount', 'attributes.receipt_issued'], roleDefault: 'donor' },
  { id: 'remittance', icon: 'send', name: '仕送り', sub: '', kind: 'remittance',
    main: ['roles.sender', 'roles.recipient', 'when.on', 'amounts.amount', 'attributes.method', 'attributes.purpose'], roleDefault: 'sender' },
];

export const FAMILY_QUICK: Quick[] = [
  { id: 'parentage', icon: 'users', name: '親子', kind: 'parentage', main: ['roles.parent', 'roles.child', 'when.on', 'attributes.basis'] },
  { id: 'marriage', icon: 'heart', name: '結婚', kind: 'marriage', main: ['roles.spouse_a', 'roles.spouse_b', 'when.from_on', 'when.to_on'] },
  { id: 'resident', icon: 'home', name: '住所', kind: 'resident_record', main: ['roles.person', 'when.from_on', 'when.to_on', 'attributes.municipality_code', 'attributes.householder', 'attributes.relation_to_householder'] },
  { id: 'insurance', icon: 'shield', name: '健康保険', kind: 'medical_insurance', main: ['roles.member', 'roles.insured', 'when.from_on', 'when.to_on', 'attributes.scheme', 'attributes.capacity', 'attributes.insurer_id'] },
  { id: 'pension', icon: 'building', name: '年金', kind: 'national_pension', main: ['roles.member', 'when.from_on', 'when.to_on', 'attributes.category'] },
  { id: 'school', icon: 'book', name: '学生', kind: 'enrollment', main: ['roles.person', 'when.from_on', 'when.to_on', 'attributes.school_type', 'attributes.attendance'] },
  { id: 'business', icon: 'briefcase', name: '副業・事業', kind: 'business', main: ['roles.owner', 'when.from_on', 'attributes.description'] },
  { id: 'cohab', icon: 'home', name: '同居', kind: 'cohabitation', main: ['roles.person', 'roles.other_person', 'when.from_on', 'when.to_on'] },
];

export type Field = { path: string; schema: any; required?: any; label?: string; hint?: string };

// ------------------------------------------------------------------ 型
export function typeOf(schema: any): any {
  if (!schema || typeof schema !== 'object') return { t: 'json' };
  if (schema.$ref) {
    const n: string = schema.$ref.split('/').pop();
    if (n === 'date') return { t: 'date' };
    if (n === 'yen') return { t: 'yen' };
    if (n === 'signed_yen') return { t: 'syen' };
    if (n === 'year' || n === 'count') return { t: 'int' };
    if (n === 'ratio' || n === 'rate' || n === 'fraction') return { t: 'fraction' };
    if (n === 'period') return { t: 'period' };
    if (n === 'ref_person') return { t: 'person' };
    if (n.startsWith('ref_kind_')) return { t: 'record', kind: n.slice('ref_kind_'.length) };
    if (n.startsWith('ref_')) return { t: 'record' };
    if (n === 'municipality_code') return { t: 'municipality' };
    if (n === 'id') return { t: 'text', pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/ };
    if (n === 'datetime') return { t: 'text', hint: 'YYYY-MM-DDThh:mm:ss+09:00' };
    return { t: 'text', def: n };
  }
  if (schema.const !== undefined) return { t: 'const', value: schema.const };
  if (schema.type === 'boolean') return { t: 'bool' };
  if (schema.type === 'string' && schema.enum) return { t: 'enum', values: schema.enum };
  if (schema.type === 'string') return { t: 'text' };
  if (schema.type === 'integer') return { t: 'int' };
  if (schema.type === 'array') {
    const it = typeOf(schema.items || {});
    if (it.t === 'enum') return { t: 'enums', values: it.values };
    if (it.t === 'date') return { t: 'dates' };
    if (it.t === 'person') return { t: 'persons' };
    if (it.t === 'text' || it.t === 'record') return { t: 'list' };
    if (it.t === 'object') return { t: 'objlist', schema: it.schema };
    return { t: 'json' };
  }
  if (schema.type === 'object' && schema.properties) return { t: 'object', schema };
  return { t: 'json' };
}

function parseYen(s: unknown, signed: boolean): number | undefined {
  const t = String(s).replace(/[,，円¥\s]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (t === '') return undefined;
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(t)) throw new Error('金額を数字で入力');
  return parseInt(t, 10);
}

function parseFraction(s: unknown): { num: number; den: number } | undefined {
  const t = String(s).trim();
  if (!t) return undefined;
  let m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return { num: +m[1], den: +m[2] };
  m = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) { const p = m[1].split('.'); const d = p[1] ? 10 ** p[1].length : 1; return { num: Math.round(parseFloat(m[1]) * d), den: 100 * d }; }
  throw new Error('例：30%');
}

function getAt(obj: any, path: string): any { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setAt(obj: any, path: string, v: any) {
  const ks = path.split('.');
  let o = obj;
  ks.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
  o[ks[ks.length - 1]] = v;
}

// ------------------------------------------------------------------ 1つの欄
// 市区町村を名前で選ぶ（総務省の団体コードの一覧。大きいので使うときに読む）
let MUNI: string[][] | null = null;
// 政令指定都市の区：[区のコード, 都道府県, 市と区の名前, その市のコード]。区の名前でも選べるが、登録するのは市のコード
let WARDS: string[][] = [];
const muniReady = (): Promise<string[][]> => (MUNI ? Promise.resolve(MUNI) : import('./municipalities.js').then((m) => { MUNI = m.MUNICIPALITIES as string[][]; WARDS = (m.WARDS || []) as string[][]; return MUNI; }));
const muniText = (r: string[]) => `${r[1]} ${r[2]}`;

/**
 * 欄の部品が外に出すもの。read は値（なければ undefined、形が違えば例外）。
 * raw・setRaw は入力欄が1つだけの部品にある（同じ値を写す欄で使う）
 */
type WHandle = { read(): any; raw?(): string; setRaw?(v: string): void };
type WProps = { ty: any; init: any; ctx: any; id: string; onCommit?: (v: string) => void; ref?: Ref<WHandle> };

function MuniWidget({ init, id, ref }: WProps) {
  const listId = `${id}-list`;
  const [all, setAll] = useState<string[][] | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    let alive = true;
    muniReady().then((list) => {
      if (!alive) return;
      setAll(list);
      const cur = init && list.find((r) => r[0] === init);
      if (cur) setText(muniText(cur));
      else if (init) setText(String(init));
    });
    return () => { alive = false; };
    // 最初の値は開いたときに1度だけ入れる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useImperativeHandle(ref, () => ({
    read: () => {
      const t = text.trim().replace(/\s+/g, ' ');
      if (!t) return undefined;
      if (/^\d{6}$/.test(t)) return t;
      const squeezed = t.replace(/ /g, '');
      const ward = WARDS.filter((w) => `${w[1]}${w[2]}` === squeezed || w[2] === squeezed);
      if (ward.length === 1) return ward[0][3];
      const list = MUNI || [];
      const hit = list.filter((r) => muniText(r) === t || `${r[1]}${r[2]}` === t.replace(/ /g, ''));
      const byName = hit.length ? hit : list.filter((r) => r[2] === t);
      if (byName.length === 1) return byName[0][0];
      throw new Error(byName.length > 1 ? '都道府県名も入れて、候補から選んでください' : '候補から選んでください');
    },
  }));
  return (
    <div>
      <input type="search" id={id} list={listId} autoComplete="off" placeholder="例：練馬区" value={text} onChange={(e) => setText(e.target.value)} />
      <datalist id={listId}>
        {(all || []).map((r) => <option key={r[0]} value={muniText(r)} />)}
        {all ? WARDS.map((w) => <option key={w[0]} value={`${w[1]} ${w[2]}`} />) : null}
      </datalist>
      {WARDS.some((w) => `${w[1]}${w[2]}` === text.replace(/\s/g, '') || w[2] === text.trim()) ? <div className="hint">政令指定都市の区は、その市として登録します（住民税を課すのは市のため）</div> : null}
    </div>
  );
}

function PeriodWidget({ init, ref }: WProps) {
  const [a, setA] = useState<string>(init?.from_on || '');
  const [b, setB] = useState<string>(init?.to_on || '');
  useImperativeHandle(ref, () => ({ read: () => (a ? { from_on: a, ...(b ? { to_on: b } : {}) } : undefined) }));
  return (
    <div className="inline">
      <input type="date" value={a} onChange={(e) => setA(e.target.value)} />
      <span style={{ flex: 'none' }}>〜</span>
      <input type="date" value={b} onChange={(e) => setB(e.target.value)} />
    </div>
  );
}

// 人・選択肢を複数選ぶ（チェックの並び）
function ChecksWidget({ ty, init, ctx, ref }: WProps) {
  const items: Array<[string, string]> = ty.t === 'persons'
    ? ctx.persons.map((p: any) => [p.person_id, p.display_name])
    : ty.values.map((v: string) => [v, enumLabel(v, ctx.enumExtra)]);
  const [on, setOn] = useState<string[]>(() => (Array.isArray(init) ? init : []));
  useImperativeHandle(ref, () => ({
    read: () => { const v = items.filter(([k]) => on.includes(k)).map(([k]) => k); return v.length ? v : undefined; },
  }));
  return (
    <div className="checks">
      {items.map(([k, label]) => (
        <label key={k}>
          <input type="checkbox" value={k} checked={on.includes(k)} onChange={(e) => setOn((cur) => (e.target.checked ? [...cur.filter((x) => x !== k), k] : cur.filter((x) => x !== k)))} />
          {label}
        </label>
      ))}
    </div>
  );
}

// オブジェクトの欄を、項目ごとの入力欄にする（JSON を書かせない）
function ObjectFields({ schema, init, ctx, ref }: { schema: any; init: any; ctx: any; ref?: Ref<{ read(): any }> }) {
  const base = useId();
  const req = new Set<string>(schema.required || []);
  const parts = Object.entries(schema.properties || {}) as Array<[string, any]>;
  const handles = useRef<Record<string, WHandle | null>>({});
  useImperativeHandle(ref, () => ({
    read: () => {
      const out: Record<string, any> = {};
      for (const [name] of parts) {
        const w = handles.current[name];
        const v = w ? w.read() : undefined;
        if (v !== undefined) out[name] = v;
        else if (req.has(name) && Object.keys(out).length) throw new Error(`${fieldLabel(name)}を入力`);
      }
      return Object.keys(out).length ? out : undefined;
    },
  }));
  return (
    <>
      {parts.map(([name, sch]) => {
        const id = `${base}-${name}`;
        return (
          <div className="field" key={name}>
            <label htmlFor={id}>{fieldLabel(name)}{req.has(name) ? <span className="req">*</span> : null}</label>
            <Widget ty={typeOf(sch)} init={init[name]} ctx={ctx} id={id} ref={(h) => { handles.current[name] = h; }} />
          </div>
        );
      })}
    </>
  );
}

function ObjectWidget({ ty, init, ctx, ref }: WProps) {
  return <div className="subform"><ObjectFields schema={ty.schema} init={init || {}} ctx={ctx} ref={ref} /></div>;
}

function ObjListWidget({ ty, init, ctx, ref }: WProps) {
  const seq = useRef(0);
  const [rows, setRows] = useState<Array<{ key: number; init: any }>>(() =>
    (Array.isArray(init) && init.length ? init : [undefined]).map((v: any) => ({ key: ++seq.current, init: v })));
  const handles = useRef<Record<number, { read(): any } | null>>({});
  useImperativeHandle(ref, () => ({
    read: () => {
      const v = rows.map((r) => { const hd = handles.current[r.key]; return hd ? hd.read() : undefined; }).filter((x) => x !== undefined);
      return v.length ? v : undefined;
    },
  }));
  return (
    <div>
      <div className="subrows">
        {rows.map((r) => (
          <div className="subform" key={r.key}>
            <ObjectFields schema={ty.schema} init={r.init || {}} ctx={ctx} ref={(hd) => { handles.current[r.key] = hd; }} />
            <button type="button" className="btn small ghost danger" onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}>削除</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn small" onClick={() => setRows((cur) => [...cur, { key: ++seq.current, init: undefined }])}>＋ 追加</button>
    </div>
  );
}

// 入力欄が1つだけの部品の、最初の文字（選択肢にない値は、古い画面と同じく「選択」に戻す）
function initText(ty: any, init: any, ctx: any): string {
  switch (ty.t) {
    case 'date': return init || '';
    case 'yen': case 'syen': return init != null ? Number(init).toLocaleString('ja-JP') : '';
    case 'int': return init != null ? String(init) : '';
    case 'fraction': return init ? `${init.num}/${init.den}` : '';
    case 'person': return ctx.persons.some((p: any) => p.person_id === init) ? init : '';
    case 'record': return init || '';
    case 'bool': return init === true ? 'true' : init === false ? 'false' : '';
    case 'enum': return ty.values.includes(init) ? init : '';
    case 'dates': case 'list': return Array.isArray(init) ? init.join(' ') : '';
    case 'text': return String(init ?? '');
    case 'const': return String(ty.value);
    default: return init !== undefined ? String(init) : '';
  }
}

function readText(ty: any, s: string): any {
  switch (ty.t) {
    case 'date': case 'person': case 'record': case 'enum': return s || undefined;
    case 'yen': case 'syen': return parseYen(s, ty.t === 'syen');
    case 'int': { if (s === '') return undefined; const n = Number(s); if (!Number.isInteger(n)) throw new Error('整数で入力'); return n; }
    case 'fraction': return parseFraction(s);
    case 'bool': return s === '' ? undefined : s === 'true';
    case 'dates': case 'list': { const v = s.split(/[\s,、]+/).filter(Boolean); return v.length ? v : undefined; }
    case 'text': {
      const v = s.trim();
      if (!v) return undefined;
      if (ty.pattern && !ty.pattern.test(v)) throw new Error(ty.hint || '形式が正しくありません');
      if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error('使えない文字があります');
      return v;
    }
    case 'const': return ty.value;
    default: { const v = s.trim(); return v || undefined; }
  }
}

// 入力欄が1つだけの部品（日付・金額・数・選択・文字）
function SimpleWidget({ ty, init, ctx, id, onCommit, ref }: WProps) {
  const [val, setVal] = useState<string>(() => initText(ty, init, ctx));
  const atFocus = useRef(val);
  useImperativeHandle(ref, () => ({ read: () => readText(ty, val), raw: () => val, setRaw: (v: string) => setVal(v) }));
  // 選ぶ欄・日付は変えたとき、文字の欄は離れたときに「変わった」と知らせる（古い画面の change と同じ）
  const pick = (v: string) => { setVal(v); if (onCommit) onCommit(v); };
  const typing = {
    value: val,
    onChange: (e: { target: { value: string } }) => setVal(e.target.value),
    onFocus: () => { atFocus.current = val; },
    onBlur: () => { if (val !== atFocus.current && onCommit) onCommit(val); },
  };
  switch (ty.t) {
    case 'date':
      return <input type="date" id={id} value={val} onChange={(e) => pick(e.target.value)} />;
    case 'yen': case 'syen':
      return (
        <input type="text" id={id} className="yen-input" inputMode="numeric" placeholder="0" {...typing}
          onBlur={() => {
            let next = val;
            try { const v = parseYen(val, ty.t === 'syen'); if (v !== undefined) next = v.toLocaleString('ja-JP'); } catch { /* 読むときに知らせる */ }
            if (next !== val) setVal(next);
            if (val !== atFocus.current && onCommit) onCommit(next);
          }} />
      );
    case 'int':
      return <input type="number" id={id} step="1" {...typing} />;
    case 'fraction':
      return <input type="text" id={id} placeholder="30%" {...typing} />;
    case 'person':
      return (
        <select id={id} value={val} onChange={(e) => pick(e.target.value)}>
          <option value="">選択</option>
          {ctx.persons.map((p: any) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
        </select>
      );
    case 'record': {
      const opts = (ctx.records || []).filter((r: any) => !ty.kind || r.record.kind === ty.kind);
      if (opts.length) {
        return (
          <select id={id} value={val} onChange={(e) => pick(e.target.value)}>
            <option value="">選択</option>
            {opts.map((r: any) => <option key={r.record.id} value={r.record.id}>{recordLabel(r.record, ctx)}</option>)}
            {init && !opts.some((r: any) => r.record.id === init) ? <option value={init}>{init}</option> : null}
          </select>
        );
      }
      return <input type="text" id={id} placeholder="先に家族の画面で追加" {...typing} />;
    }
    case 'bool':
      return (
        <select id={id} value={val} onChange={(e) => pick(e.target.value)}>
          <option value="">—</option>
          <option value="true">はい</option>
          <option value="false">いいえ</option>
        </select>
      );
    case 'enum':
      return (
        <select id={id} value={val} onChange={(e) => pick(e.target.value)}>
          <option value="">選択</option>
          {ty.values.map((v: string) => <option key={v} value={v}>{enumLabel(v, ctx.enumExtra)}</option>)}
        </select>
      );
    case 'dates': case 'list':
      return <input type="text" id={id} placeholder={ty.t === 'dates' ? '2026-11-30 2026-12-31' : '空白で区切る'} {...typing} />;
    case 'text':
      return <input type="text" id={id} placeholder={ty.hint || ''} {...typing} />;
    case 'const':
      return <input type="text" id={id} value={val} disabled readOnly />;
    case 'json':
    default:
      return <input type="text" id={id} placeholder="" {...typing} />;
  }
}

function Widget(p: WProps) {
  switch (p.ty.t) {
    case 'municipality': return <MuniWidget {...p} />;
    case 'period': return <PeriodWidget {...p} />;
    case 'persons': case 'enums': return <ChecksWidget {...p} />;
    case 'object': return <ObjectWidget {...p} />;
    case 'objlist': return <ObjListWidget {...p} />;
    default: return <SimpleWidget {...p} />;
  }
}

export function recordLabel(rec: any, ctx: any): string {
  const name = (ctx.kindTitle && ctx.kindTitle(rec.kind)) || rec.kind;
  const w = rec.when || {};
  const d = w.on || w.from_on || w.tax_year || w.fiscal_year || '';
  const desc = rec.attributes?.description || rec.attributes?.counterparty || rec.attributes?.name || '';
  // 選ぶときに見分けられるように、中身（説明・相手の名前）を先に出す。種類の名前の、かっこの中の説明は落とす
  const short = String(name).replace(/[（(].*$/, '');
  return `${desc || short}${desc ? `（${short}）` : ''}${d ? ` ${d}〜` : ''}`.trim();
}

// ------------------------------------------------------------------ 記録のフォーム
export function fieldsForRecord(km: any): Field[] {
  const out: Field[] = [];
  for (const [r, req] of Object.entries(km.roles || {})) out.push({ path: `roles.${r}`, schema: { $ref: '#/$defs/ref_person' }, required: req });
  const w = km.when;
  if (w === 'on') out.push({ path: 'when.on', schema: { $ref: '#/$defs/date' }, required: true, label: '日付' });
  else if (w === 'period') { out.push({ path: 'when.from_on', schema: { $ref: '#/$defs/date' }, required: true }); out.push({ path: 'when.to_on', schema: { $ref: '#/$defs/date' }, required: false }); }
  else if (w === 'on_or_period') { out.push({ path: 'when.on', schema: { $ref: '#/$defs/date' }, required: false, hint: '' }); out.push({ path: 'when.from_on', schema: { $ref: '#/$defs/date' }, required: false }); out.push({ path: 'when.to_on', schema: { $ref: '#/$defs/date' }, required: false }); }
  else if (w === 'tax_year') out.push({ path: 'when.tax_year', schema: { type: 'integer' }, required: true });
  else if (w === 'fiscal_year') out.push({ path: 'when.fiscal_year', schema: { type: 'integer' }, required: true });
  for (const [n, f] of Object.entries(km.amounts || {}) as Array<[string, any]>) out.push({ path: `amounts.${n}`, schema: f.schema, required: f.required });
  for (const [n, f] of Object.entries(km.attributes || {}) as Array<[string, any]>) out.push({ path: `attributes.${n}`, schema: f.schema, required: f.required });
  out.push({ path: 'note', schema: { type: 'string' }, required: false, label: 'メモ' });
  out.push({ path: 'mark', schema: { type: 'string', enum: ['予測', '見積り', '計画'] }, required: false, label: '見込み' });
  return out;
}

export function fieldsForLedger(lk: any): Field[] {
  const out: Field[] = [];
  for (const [n, f] of Object.entries(lk.subject || {}) as Array<[string, any]>) out.push({ path: `subject.${n}`, schema: f.schema, required: f.required });
  const w = lk.when;
  if (w === 'on') out.push({ path: 'when.on', schema: { $ref: '#/$defs/date' }, required: true });
  else if (w === 'period') { out.push({ path: 'when.from_on', schema: { $ref: '#/$defs/date' }, required: true }); out.push({ path: 'when.to_on', schema: { $ref: '#/$defs/date' }, required: false }); }
  else if (w === 'tax_year') out.push({ path: 'when.tax_year', schema: { type: 'integer' }, required: true });
  else if (w === 'fiscal_year') out.push({ path: 'when.fiscal_year', schema: { type: 'integer' }, required: true });
  const v = lk.value;
  if (v && v.type === 'object' && v.properties) {
    const req = new Set(v.required || []);
    for (const [n, s] of Object.entries(v.properties)) out.push({ path: `value.${n}`, schema: s, required: req.has(n) });
  } else {
    out.push({ path: 'value', schema: v, required: true, label: '回答' });
  }
  return out;
}

export type FormHandle = { read(): { value: any; errors: string[] }; unverified(): number };

/**
 * フォーム（古い buildForm）。
 * fields, initial, main(パスの配列|null), ctx: {persons, records, kindTitle, enumExtra}, ai: Set(パス), sync: [[写す元, 写す先]]
 * ref: { read() → {value, errors}, unverified() → 未確認の欄の数 }
 */
export function RecordForm({ fields, initial = {}, main = null, ctx, ai, sync, ref }: {
  fields: Field[]; initial?: any; main?: string[] | null; ctx: any; ai?: Set<string>; sync?: Array<[string, string]> | null; ref?: Ref<FormHandle>;
}): JSX.Element {
  const base = useId();
  const handles = useRef<Record<string, WHandle | null>>({});
  const verifyEls = useRef<Record<string, HTMLInputElement | null>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [head, setHead] = useState<string>(() => {
    const hh = String(getAt(initial, 'attributes.household_id') || '');
    if (getAt(initial, 'attributes.householder') !== false || !hh.startsWith('hh-')) return '';
    return hh.startsWith('hh-other-') ? 'other' : hh.slice(3);
  });
  const [headErr, setHeadErr] = useState(false);

  const mainSet = main ? new Set(main) : new Set(fields.filter((f) => f.required).map((f) => f.path));
  const ordered = main ? [...main.map((p) => fields.find((f) => f.path === p)).filter((f): f is Field => !!f), ...fields.filter((f) => !mainSet.has(f.path))] : fields;
  // 世帯の ID は画面に出さない。世帯主が本人ならその人の世帯、本人でなければ「世帯主は誰か」から決める（サーバーも同じ決まりで確かめる）
  const autoHousehold = fields.some((f) => f.path === 'attributes.household_id') && fields.some((f) => f.path === 'attributes.householder');
  const items = ordered.filter((f) => !(autoHousehold && f.path === 'attributes.household_id')).map((f) => {
    const type = typeOf(f.schema);
    const init = getAt(initial, f.path);
    return { f, type, init, isAi: !!ai && ai.has(f.path) && init !== undefined };
  });

  useImperativeHandle(ref, () => ({
    read() {
      const value: any = {};
      const errors: string[] = [];
      const marks: Record<string, string> = {};
      for (const it of items) {
        let v;
        try { const w = handles.current[it.f.path]; v = w ? w.read() : undefined; } catch (e: any) { marks[it.f.path] = e.message; errors.push(it.f.path); continue; }
        if (v === undefined) {
          if (it.f.required) { marks[it.f.path] = '必須'; errors.push(it.f.path); }
          continue;
        }
        setAt(value, it.f.path, v);
      }
      setErrs(marks);
      if (autoHousehold && value.attributes) {
        const who = value.roles && value.roles.person;
        let bad = false;
        if (value.attributes.householder === true) {
          if (who) value.attributes.household_id = `hh-${who}`;
        } else if (value.attributes.householder === false) {
          if (head === 'other' && who) value.attributes.household_id = `hh-other-${who}`;
          else if (head && head !== who) value.attributes.household_id = `hh-${head}`;
          else { bad = true; errors.push('attributes.household_id'); }
        }
        setHeadErr(bad);
      }
      for (const k of ['amounts', 'attributes', 'roles', 'when', 'subject']) if (value[k] && !Object.keys(value[k]).length) delete value[k];
      return { value, errors };
    },
    unverified() { return items.filter((i) => i.isAi && !verified[i.f.path]).length; },
  }));

  // 同じ値を写す欄（給与の支給日 → 日付など）。写す先が空のときだけ写す
  const commit = (from: string, v: string) => {
    for (const [a, b] of sync || []) {
      if (a !== from) continue;
      const to = handles.current[b];
      if (to && to.raw && to.setRaw && !to.raw()) to.setRaw(v);
    }
  };
  const synced = new Set((sync || []).map(([a]) => a));

  const box = (it: (typeof items)[number]) => {
    const { f, type, init, isAi } = it;
    const path = f.path;
    const id = `${base}-${path}`;
    const name = f.label || fieldLabel(path.split('.').pop());
    const hint = f.hint || type.hint;
    const err = errs[path];
    // AI が読んだ欄：人が値を直したら、確かめたことにする（チェックそのものの操作は除く）
    const touched = isAi ? (e: FormEvent<HTMLDivElement>) => {
      if (e.target === verifyEls.current[path]) return;
      setVerified((cur) => (cur[path] ? cur : { ...cur, [path]: true }));
    } : undefined;
    return (
      <div key={path} className={`field${isAi && !verified[path] ? ' ai' : ''}${err !== undefined ? ' err' : ''}`} onInput={touched}>
        <label htmlFor={id}>{name}{f.required ? <span className="req">*</span> : null}
          {isAi ? <span className="chip unverified" style={{ marginLeft: '6px' }}>AI</span> : null}</label>
        <Widget ty={type} init={init} ctx={ctx} id={id} onCommit={synced.has(path) ? (v) => commit(path, v) : undefined} ref={(h) => { handles.current[path] = h; }} />
        {isAi ? (
          <label className="hint ai-check" style={{ fontWeight: 400 }}>
            <input type="checkbox" title="チェック" checked={!!verified[path]} ref={(el) => { verifyEls.current[path] = el; }}
              onChange={(e) => { const on = e.target.checked; setVerified((cur) => ({ ...cur, [path]: on })); }} />
            {' チェック'}
          </label>
        ) : null}
        {hint ? <div className="hint">{hint}</div> : null}
        <div className="err-msg">{err || ''}</div>
      </div>
    );
  };

  const mainItems = items.filter((it) => mainSet.has(it.f.path));
  const moreItems = items.filter((it) => !mainSet.has(it.f.path));
  return (
    <div className="form">
      <div className="form-cols">{mainItems.map(box)}</div>
      {autoHousehold ? (
        <div className={`field${headErr ? ' err' : ''}`}>
          <label htmlFor={`${base}-head`}>世帯主が本人でないとき：世帯主は誰ですか</label>
          <select id={`${base}-head`} className="in" value={head} onChange={(e) => { setHead(e.target.value); setHeadErr(false); }}>
            <option value="">（本人が世帯主）</option>
            {(ctx.persons || []).map((p: any) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
            <option value="other">ここにいない人（家族以外）</option>
          </select>
          <div className="hint">住民票の「世帯主」の欄の人です。同じ世帯かどうかは、ここで決まります</div>
          <div className="err-msg">{headErr ? '世帯主が本人でないときは、世帯主を選んでください（本人以外）' : ''}</div>
        </div>
      ) : null}
      {moreItems.length ? (
        <details className="more" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>{`詳細（${moreItems.length}）`}</summary>
          <div className="form-cols">{moreItems.map(box)}</div>
        </details>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 表示
export function recordSummary(rec: any): string {
  const a = rec.amounts || {};
  const main = a.gross ?? a.amount ?? a.payment_amount ?? a.proceeds ?? a.credit_amount;
  return main != null ? yen(main) : '';
}

export function recordDate(rec: any): string {
  const w = rec.when || {};
  if (w.on) return w.on;
  if (w.from_on) return `${w.from_on}〜${w.to_on || ''}`;
  if (w.tax_year) return `${w.tax_year}年分`;
  if (w.fiscal_year) return `${w.fiscal_year}年度`;
  return '';
}

// スキーマ1つ分の入力欄（ほかの画面から使う）。read は、値がなければ undefined、形が違えば例外
export function FieldWidget({ schema, initial, ctx, ref }: { schema: any; initial?: any; ctx: any; ref?: Ref<{ read(): any }> }): JSX.Element {
  const id = useId();
  return <Widget ty={typeOf(schema)} init={initial} ctx={ctx} id={id} ref={ref} />;
}

// 書類の一覧（見返すための並び）。書類の画面と、人のページの両方で使う。
// 1件は「何の書類か・いつの・いくらの・だれの」が1目で分かる行にする（ファイル名や容量は主役にしない）
import { useEffect } from 'react';
import { Link } from 'react-router';
import { QUICK, recordDate, recordSummary } from '../lib/forms';
import { kindTitle, loadRecords, personName, useS } from '../lib/store';
import { useApi } from '../lib/useApi';
import { Icon } from '../ui/Icon';
import { Avatar } from '../ui/bits';
import { toast } from '../ui/overlay';

export function evStatus(e: any): string {
  if (e.ignored) return 'ignored';
  if (e.records.length) return 'done';
  if (e.pending) return 'pending';
  return 'new';
}

const linked = (e: any, records: any[] | null): any[] => {
  const ids = new Set<string>(e.records || []);
  return (records || []).map((r) => r.record || r).filter((r) => ids.has(r.id));
};

/** 書類の種類の名前（給与明細・源泉徴収票…）。選んだ種類、なければ登録した記録の種類。どちらもなければ「未分類」 */
export function docKindName(e: any, records: any[] | null = null): string {
  const q = QUICK.find((x: any) => x.id === e.doc_type);
  if (q) return q.name;
  const rec = linked(e, records)[0];
  if (rec) {
    const byKind = QUICK.find((x: any) => x.kind === rec.kind);
    return byKind ? byKind.name : kindTitle(rec.kind);
  }
  return '未分類';
}

/** 人が付けた名前（あれば）。アップロードしたときのファイル名は名前として扱わない（何の書類かが分からないため） */
export function docGivenName(e: any): string {
  const label = String(e.label || '').trim();
  return label && !/\.[A-Za-z0-9]{2,5}$/.test(label) ? label : '';
}

/** 一覧の見出し：その書類が何であるか。人が付けた名前 → 種類 → 「名前のない書類」 */
export function docTitle(e: any, records: any[] | null = null): string {
  const given = docGivenName(e);
  if (given) return given;
  const kind = docKindName(e, records);
  return kind === '未分類' ? '名前のない書類' : kind;
}

/** 書類に結びついた記録から、日付と金額を取る（見返すときの手がかり）。記録がなければ空 */
export function docFacts(e: any, records: any[] | null): { date: string; amount: string } {
  const recs = linked(e, records);
  const date = recs.map((r) => recordDate(r)).filter(Boolean).sort()[0] || '';
  const amount = recs.map((r) => recordSummary(r)).filter(Boolean)[0] || '';
  return { date, amount };
}

/** 並べるときの年：書類の日付（記録から）。なければ追加した日 */
export function docYear(e: any, records: any[] | null): string {
  const d = docFacts(e, records).date || e.uploaded_at || '';
  return /^\d{4}/.test(d) ? d.slice(0, 4) : '';
}

const fileUrl = (e: any) => `/api/evidence/${encodeURIComponent(e.id)}/file`;

/** 書類を共有する（スマホの共有の画面を出す。LINE などに送れる）。使えない端末ではダウンロードにする */
export async function shareDoc(e: any): Promise<void> {
  const name = `${docTitle(e)}.${e.ext}`;
  try {
    const res = await fetch(fileUrl(e), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('書類を読み込めませんでした');
    const file = new File([await res.blob()], name, { type: e.mime });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: name }); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err: any) {
    if (err && err.name === 'AbortError') return; // 共有の画面を閉じただけ
    toast((err && err.message) || '共有できませんでした', 'bad');
  }
}

function Thumb({ e }: { e: any }) {
  const isImg = String(e.mime).startsWith('image/') && e.mime !== 'image/heic';
  return <span className="doc-thumb">{isImg ? <img src={fileUrl(e)} alt="" loading="lazy" /> : <span>{String(e.ext).toUpperCase()}</span>}</span>;
}

/** 1件の行。showOwner：だれの書類かを出す（人で絞っていないとき） */
export function DocRow({ e, records, showOwner }: { e: any; records: any[] | null; showOwner: boolean }) {
  const st = evStatus(e);
  const f = docFacts(e, records);
  const title = docTitle(e, records);
  const kind = docKindName(e, records);
  // 名前を付けた書類は、種類も添える（「2026年10月分」＋「給与明細」）
  const sub = [title !== kind && kind !== '未分類' ? kind : '', f.date || `${String(e.uploaded_at || '').slice(0, 10)} 追加`, f.amount].filter(Boolean).join('・');
  return (
    <Link className="doc-row" to={`/evidence/${encodeURIComponent(e.id)}`}>
      <Thumb e={e} />
      <span className="doc-main">
        <b className={title === '名前のない書類' ? 'unnamed' : ''}>{title}</b>
        <span className="doc-sub">{sub}</span>
        <span className="doc-meta">
          {showOwner ? <span className="doc-owner"><Avatar id={e.owner_person} name={personName(e.owner_person)} small />{personName(e.owner_person)}</span> : null}
          {st === 'new' ? <span className="chip warn">未登録</span> : st === 'pending' ? <span className="chip unverified">確認待ち</span> : st === 'ignored' ? <span className="chip">参考資料</span> : null}
        </span>
      </span>
      <Icon name="chevronRight" size={16} cls="muted" />
    </Link>
  );
}

/** 年ごとにまとめた一覧（新しい年が上） */
export function DocList({ items, records, showOwner }: { items: any[]; records: any[] | null; showOwner: boolean }) {
  const groups = new Map<string, any[]>();
  for (const e of items) {
    const y = docYear(e, records) || '日付なし';
    groups.set(y, [...(groups.get(y) || []), e]);
  }
  const years = [...groups.keys()].sort().reverse();
  return (
    <>{years.map((y) => (
      <section key={y} className="doc-group">
        <h3 className="doc-year">{/^\d{4}$/.test(y) ? `${y}年` : y}<span className="muted">{`${groups.get(y)!.length}件`}</span></h3>
        <div className="card flush">{groups.get(y)!.map((e) => <DocRow key={e.id} e={e} records={records} showOwner={showOwner} />)}</div>
      </section>
    ))}</>
  );
}

/** 記録（書類の日付・金額を出すのに使う）を読んでおく */
export function useDocRecords(): any[] | null {
  const records = useS((s) => s.records);
  useEffect(() => { if (!records) loadRecords().catch(() => {}); }, [records]);
  return records;
}

/** 人のページ：その人の書類（新しいものから数件）と、全部を見る入口 */
export function PersonDocs({ pid }: { pid: string }) {
  const q = useApi('/api/evidence');
  const records = useDocRecords();
  if (!q.data) return null;
  const mine = (q.data.evidence as any[]).filter((e) => e.owner_person === pid);
  const to = `/upload/${encodeURIComponent(pid)}`;
  return (
    <div className="card flush" style={{ marginBottom: '16px' }}>
      <div className="card-head"><h3>書類</h3><span className="grow" />
        <Link className="btn small" to={to}><Icon name="camera" size={14} />追加</Link></div>
      {mine.length ? (
        <>
          {mine.slice(0, 4).map((e) => <DocRow key={e.id} e={e} records={records} showOwner={false} />)}
          {mine.length > 4 ? <Link className="doc-more" to={to}>{`すべて見る（${mine.length}件）`}<Icon name="chevronRight" size={14} /></Link> : null}
        </>
      ) : <div className="empty" style={{ padding: '20px' }}>まだ書類がありません</div>}
    </div>
  );
}

// 家族（人）の追加の提案：AI・エージェントは提案するだけ。人が名前と生年月日を確かめて「登録」を押したときに増える
import { useState } from 'react';
import { post } from '../lib/api';
import { refreshStatus } from '../lib/status';
import { loadHousehold } from '../lib/store';
import { modal, toast } from '../ui/overlay';

export const isPersonProposal = (pr: any) => pr && pr.kind === 'person';

export function personProposalLine(pr: any): string {
  const r = (pr.payload || {}).record || {};
  return [r.display_name, r.birth_on ? `${r.birth_on} 生まれ` : ''].filter(Boolean).join('・');
}

/** 登録する（人が押したときだけ呼ぶ）。record を渡すと、直した名前・生年月日で登録する */
export async function acceptPersonProposal(pr: any, record?: { display_name: string; birth_on: string }): Promise<void> {
  await post(`/api/proposals/${encodeURIComponent(pr.id)}/accept`, record ? { record } : {});
  await loadHousehold(true);
  refreshStatus();
}

function Fields({ held }: { held: { display_name: string; birth_on: string } }) {
  const [name, setName] = useState(held.display_name);
  const [birth, setBirth] = useState(held.birth_on);
  return (
    <div className="form">
      <div className="field"><label>名前</label>
        <input type="text" className="in" maxLength={40} value={name} onChange={(e) => { held.display_name = e.target.value; setName(e.target.value); }} /></div>
      <div className="field"><label>生年月日</label>
        <input type="date" className="in" value={birth} onChange={(e) => { held.birth_on = e.target.value; setBirth(e.target.value); }} /></div>
    </div>
  );
}

/** 名前と生年月日を確かめて（直して）登録する。登録したら true */
export async function reviewPersonProposal(pr: any): Promise<boolean> {
  const r = (pr.payload || {}).record || {};
  const held = { display_name: String(r.display_name || ''), birth_on: String(r.birth_on || '') };
  const ok = await modal('家族を追加',
    <>
      <Fields held={held} />
      {pr.rationale ? <p className="muted" style={{ marginTop: '10px' }}>{pr.rationale}</p> : null}
    </>,
    [{ label: 'やめる', value: false }, { label: '登録', kind: 'primary', run: async () => {
      if (!held.display_name.trim() || !held.birth_on) { toast('名前と生年月日を入れてください', 'bad'); return false; }
      await acceptPersonProposal(pr, { display_name: held.display_name.trim(), birth_on: held.birth_on });
      return true;
    } }]);
  return !!ok;
}

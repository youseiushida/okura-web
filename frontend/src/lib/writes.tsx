// 記録を登録する書き込み：同じ内容の記録がすでにあるときは、人に確かめてから（二度押し・二重の取り込みを止める）
import { post, ApiError } from './api';
import { confirmBox } from '../ui/overlay';

/** 登録をやめたとき（同じ内容の記録があった）。呼び出し元はそのまま画面に残る */
export class Cancelled extends Error {
  constructor() { super('登録をやめました（同じ内容の記録があります）'); }
}

/** post と同じ。サーバーが「同じ内容の記録がある」と止めたら、確かめてから登録し直す */
export async function postChecked<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await post<T>(path, body);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'duplicate_record') throw e;
    const ok = await confirmBox('同じ内容の記録があります', 'すでに同じ内容の記録が登録されています。それでも、もう1件登録しますか？', 'もう1件登録する');
    if (!ok) throw new Cancelled();
    return post<T>(path, { ...body, allow_duplicate: true });
  }
}

// 文件开头说明：M1 本机作品物理回收器。它只处理已到期的 deleted/
// pending_deletion 作品，固定按对象文件 → WorkAsset → WorkDocument → Work 的
// 顺序执行，以符合受控外键边界。对象删除通过统一 ObjectStore 端口执行。
import type { Payload } from 'payload'

import { getObjectStore } from '@/storage'

const maximumWorksPerRun = 25

export const purgeExpiredWorks = async (payload: Payload): Promise<number> => {
  const now = new Date().toISOString()
  const candidates = await payload.find({
    collection: 'works',
    depth: 0,
    limit: maximumWorksPerRun,
    overrideAccess: true,
    where: {
      and: [
        { state: { in: ['deleted', 'pending_deletion'] } },
        { recoverableUntil: { less_than: now } },
      ],
    },
  })

  for (const work of candidates.docs) {
    const assets = await payload.find({
      collection: 'work-assets',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      where: { work: { equals: work.id } },
    })

    // Do not remove metadata before its object is gone. A storage failure
    // leaves the work in its hidden state and the next run can safely retry.
    for (const asset of assets.docs) {
      await getObjectStore().delete(asset.storageKey)
      await payload.delete({
        collection: 'work-assets',
        id: asset.id,
        overrideAccess: true,
      })
    }

    const documents = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      where: { work: { equals: work.id } },
    })
    for (const document of documents.docs) {
      await payload.delete({
        collection: 'work-documents',
        id: document.id,
        overrideAccess: true,
      })
    }

    await payload.delete({
      collection: 'works',
      id: work.id,
      overrideAccess: true,
    })
  }

  return candidates.docs.length
}

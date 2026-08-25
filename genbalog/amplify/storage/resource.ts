// genbalog/amplify/storage/resource.ts（新規作成。既定スキャフォールドには無い）
import { defineStorage } from '@aws-amplify/backend';

/**
 * 現場写真ストレージ。
 * media/{entity_id}/* を、そのユーザー本人（identity）だけが read/write/delete できる。
 * {entity_id} は予約トークンで、アップロード時にユーザーの identity id に置換される。
 */
export const storage = defineStorage({
  name: 'genbalogMedia',
  access: (allow) => ({
    'media/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
    ],
  }),
});
import { defineStore } from 'pinia'

import { roleLabel, roleScope } from '@/data/permissions'
import type { RoleKey } from '@/data/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水电站机组运行检修管理平台',
    // 默认以运行值班员进入（导轴承标记的归属岗位）；顶栏可切换，写操作由服务层按归属校验。
    role: 'operator' as RoleKey,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    roleLabel: (state) => roleLabel(state.role),
    roleScope: (state) => roleScope(state.role),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: RoleKey) {
      this.role = role
    },
  },
})

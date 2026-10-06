import { defineStore } from 'pinia'

import { ROLE_OPTIONS, roleLabel, type RoleKey } from '@/data/roles'

export const ROLE_STORAGE_KEY = 'hydropower-plant-om:role'

function initialRole(): RoleKey {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'admin'
  }
  const saved = window.localStorage.getItem(ROLE_STORAGE_KEY) as RoleKey | null
  return saved && ROLE_OPTIONS.some((item) => item.key === saved) ? saved : 'admin'
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const role = initialRole()
    return {
      role,
      operator: roleLabel(role),
      shiftLabel: '白班 08:00-20:00',
      scope: '水电站机组运行检修管理平台',
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: RoleKey) {
      this.role = role
      this.operator = roleLabel(role)
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(ROLE_STORAGE_KEY, role)
      }
    },
  },
})

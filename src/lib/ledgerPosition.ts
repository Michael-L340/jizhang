import { PAGE_DAYS } from './ledger'

/** 只记本次离开的流水位置，编辑后按历史返回时使用。 */
export const ledgerPosition = {
  key: '',
  mode: '',
  top: 0,
  days: PAGE_DAYS,
}

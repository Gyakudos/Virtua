// Custom build version: Major.Minor.Day.Month.Year
// 0 . 010 . 19 . 11 . 26  ->  19 Nov 2026
export const BUILD_VERSION = '0.010.19.11.26'

export const VERSION_INFO = {
  major: 0,
  minor: 10,
  day: 19,
  month: 11,
  year: 2026,
  label: BUILD_VERSION
} as const

export function displayVersion(): string {
  return `v${BUILD_VERSION}`
}

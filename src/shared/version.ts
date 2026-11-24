// Release version uses the GitHub tag format: Major.Minor.Sub.Year
// 000 . 015 . 007 . 2026
export const BUILD_VERSION = '000.015.007.2026'

export const VERSION_INFO = {
  major: 0,
  minor: 15,
  sub: 7,
  year: 2026,
  label: BUILD_VERSION
} as const

export function displayVersion(): string {
  return `v${BUILD_VERSION}`
}
